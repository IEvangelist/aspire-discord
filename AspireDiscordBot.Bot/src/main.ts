import { GroundedAnswerService } from './agent/answer-service.js';
import { CopilotRuntime } from './agent/copilot-runtime.js';
import { OpenAiEmbeddingModel } from './agent/embeddings.js';
import { GitHubMcpClient } from './agent/github-mcp.js';
import { QdrantStore } from './agent/qdrant-store.js';
import { loadConfig } from './config.js';
import { DiscordGateway } from './discord/gateway.js';
import { createLogger } from './logger.js';
import { ensureOllamaModels } from './ollama-readiness.js';
import { buildServer } from './server.js';
import type { TelemetryHandle } from './telemetry.js';

export async function main(telemetry: TelemetryHandle): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const shutdownController = new AbortController();
  const embeddings = new OpenAiEmbeddingModel(config.ai);
  const qdrant = new QdrantStore(config.qdrant, logger);
  const copilot = new CopilotRuntime(config, logger);
  const githubMcp = new GitHubMcpClient(config.githubMcp, logger);
  const answers = new GroundedAnswerService(config, embeddings, qdrant, copilot, githubMcp, logger);
  const discord = new DiscordGateway(config, answers, logger, undefined, shutdownController.signal);
  const server = await buildServer({ config, discord, logger, qdrant });
  let shutdownPromise: Promise<void> | undefined;
  const lifecycle: { startup?: Promise<void> } = {};

  const shutdown = (reason: string, waitForStartup = true): Promise<void> => {
    shutdownPromise ??= (async () => {
      logger.info({ reason }, 'Shutting down.');
      shutdownController.abort(new Error(reason));
      if (waitForStartup && lifecycle.startup) {
        await lifecycle.startup.catch(() => undefined);
      }
      const results = await Promise.allSettled([
        server.close(),
        discord.stop(),
        githubMcp.close(),
        copilot.stop(),
        telemetry.shutdown(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result): unknown => result.reason);
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
    await copilot.start();
    throwIfShuttingDown(shutdownController.signal);
    await discord.start();
    throwIfShuttingDown(shutdownController.signal);
    await server.listen(config.http);
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

function throwIfShuttingDown(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Service is shutting down.');
  }
}
