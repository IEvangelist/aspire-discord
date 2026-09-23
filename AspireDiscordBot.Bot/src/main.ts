import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import { GroundedAnswerService } from './agent/answer-service.js';
import { AzureSearchStore } from './agent/azure-search-store.js';
import { CopilotRuntime } from './agent/copilot-runtime.js';
import { OpenAiEmbeddingModel } from './agent/embeddings.js';
import { GitHubMcpClient } from './agent/github-mcp.js';
import { QuestionContextResolver } from './agent/question-context.js';
import { QdrantStore } from './agent/qdrant-store.js';
import { loadConfig } from './config.js';
import { DiscordGateway } from './discord/gateway.js';
import { createLogger } from './logger.js';
import { ensureOllamaModels } from './ollama-readiness.js';
import { buildServer } from './server.js';
import type { TelemetryHandle } from './telemetry.js';
import { startRuntimeConfig } from './runtime-config.js';
import { createIssueController } from './issues/setup.js';
import { GitHubActivityReader } from './agent/github-activity.js';
import { GitHubReadService } from './agent/github-read-service.js';

export async function main(telemetry: TelemetryHandle): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info({ telemetryMode: telemetry.mode }, 'Telemetry initialized.');
  const runtimeConfig = await startRuntimeConfig(config, logger);
  const shutdownController = new AbortController();
  const embeddings = new OpenAiEmbeddingModel(config.ai);
  const vectorStore =
    config.vectorStore.provider === 'azuresearch'
      ? new AzureSearchStore(config.vectorStore, logger)
      : new QdrantStore(config.qdrant, logger);
  const copilot = new CopilotRuntime(config, logger);
  const githubMcp = new GitHubMcpClient(config.githubMcp, logger);
  const questionContext = new QuestionContextResolver(config.linkContext, githubMcp, logger);
  const answers = new GroundedAnswerService(
    config,
    embeddings,
    vectorStore,
    copilot,
    githubMcp,
    logger,
    questionContext,
    new GitHubReadService(
      new GitHubActivityReader(config.githubMcp, logger),
      githubMcp,
      copilot,
      logger,
      config.agent.maxToolCalls,
    ),
  );
  const discord = new DiscordGateway(
    config,
    answers,
    logger,
    undefined,
    shutdownController.signal,
    runtimeConfig,
    createIssueController(config.issues, runtimeConfig, copilot, logger),
  );
  const server = await buildServer({
    config,
    discord,
    logger,
    vectorStore,
  });
  let shutdownPromise: Promise<void> | undefined;
  const lifecycle: { startup?: Promise<void> } = {};

  const shutdown = (reason: string, waitForStartup = true): Promise<void> => {
    shutdownPromise ??= (async () => {
      logger.info({ reason }, 'Shutting down.');
      shutdownController.abort(new Error(reason));
      if (waitForStartup && lifecycle.startup) {
        await lifecycle.startup.catch(() => undefined);
      }
      runtimeConfig.stop();
      const results = await Promise.allSettled([
        server.close(),
        discord.stop(),
        githubMcp.close(),
        copilot.stop(),
      ]);
      const failures: unknown[] = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result): unknown => result.reason);
      if (failures.length > 0) {
        logger.error(
          { err: new AggregateError(failures, 'One or more resources failed to stop.') },
          'Resource cleanup failed during shutdown.',
        );
      }
      try {
        await telemetry.shutdown();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'One or more resources failed to stop.');
      }
    })();
    return shutdownPromise;
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(`Received ${signal}.`).then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          logger.fatal({ err: error }, 'Graceful shutdown failed.');
          process.exitCode = 1;
        },
      );
    });
  }

  lifecycle.startup = (async () => {
    await ensureOllamaModels(config.ai, logger, shutdownController.signal);
    throwIfShuttingDown(shutdownController.signal);
    await server.listen(config.http);
    logger.info(config.http, 'Aspire Discord bot HTTP service started.');
    await waitForIndexReadiness(vectorStore, logger, shutdownController.signal);
    throwIfShuttingDown(shutdownController.signal);
    await copilot.start();
    throwIfShuttingDown(shutdownController.signal);
    await discord.start();
    throwIfShuttingDown(shutdownController.signal);
    logger.info(config.http, 'Aspire Discord bot service started.');
  })();

  try {
    await lifecycle.startup;
  } catch (error) {
    if (!shutdownPromise) {
      await shutdown('Startup failed.', false).catch((cleanupError: unknown) => {
        logger.error({ err: cleanupError }, 'Startup rollback failed.');
      });
    }
    throw error;
  }
}

interface IndexReadiness {
  isReady(signal?: AbortSignal): Promise<boolean>;
}

export async function waitForIndexReadiness(
  vectorStore: IndexReadiness,
  logger: Logger,
  signal: AbortSignal,
  retryMilliseconds = 5_000,
): Promise<void> {
  let attempts = 0;
  for (;;) {
    signal.throwIfAborted();
    attempts++;
    try {
      if (await vectorStore.isReady(signal)) {
        logger.info('Compatible vector indexes are ready.');
        return;
      }
    } catch (error) {
      if (attempts === 1 || attempts % 12 === 0) {
        logger.warn({ err: error }, 'Vector indexes are not reachable yet.');
      }
    }

    if (attempts === 1 || attempts % 12 === 0) {
      logger.info('Waiting for the ingestion service to publish both vector indexes.');
    }
    await delay(retryMilliseconds, undefined, { signal });
  }
}

function throwIfShuttingDown(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Service is shutting down.');
  }
}
