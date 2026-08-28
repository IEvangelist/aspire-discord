import {
  CopilotClient,
  RuntimeConnection,
  type ProviderConfig,
  type TelemetryConfig,
  type Tool,
} from '@github/copilot-sdk';
import { context, propagation } from '@opentelemetry/api';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { AGENT_SYSTEM_PROMPT } from '../prompts.js';
import { ensureFoundryV1Endpoint, ensureV1Endpoint, getFoundryBearerToken } from './embeddings.js';

export class CopilotRuntime {
  readonly #client: CopilotClient;
  #startAttempted = false;
  #started = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    const baseDirectory =
      config.copilot.runtimeBasePath ??
      join(process.env.LOCALAPPDATA ?? homedir(), 'AspireDiscordBot', 'copilot-node');
    const telemetry = buildCopilotTelemetry(config);
    this.#client = new CopilotClient({
      baseDirectory,
      connection: RuntimeConnection.forStdio(),
      ...(config.copilot.token ? { gitHubToken: config.copilot.token } : {}),
      logLevel: config.nodeEnvironment === 'production' ? 'warning' : 'error',
      mode: 'empty',
      onGetTraceContext: () => {
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        return carrier;
      },
      sessionIdleTimeoutSeconds: 300,
      ...(telemetry ? { telemetry } : {}),
      useLoggedInUser: config.ai.provider === 'copilot' && !config.copilot.token,
      workingDirectory: tmpdir(),
    });
    void mkdir(baseDirectory, { recursive: true });
  }

  public async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#startAttempted = true;
    try {
      await this.#client.start();
      this.#started = true;
      this.logger.info('GitHub Copilot SDK runtime started in empty mode.');
    } catch (error) {
      await this.#forceCleanup();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.#started && !this.#startAttempted) {
      return;
    }
    try {
      const errors = await this.#client.stop();
      for (const error of errors) {
        this.logger.warn({ err: error }, 'Copilot runtime cleanup reported an error.');
      }
      if (errors.length > 0) {
        await this.#client.forceStop();
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Graceful Copilot runtime cleanup failed.');
      await this.#client.forceStop();
    } finally {
      this.#started = false;
      this.#startAttempted = false;
    }
  }

  public async complete(
    prompt: string,
    // The SDK models heterogeneous tool collections as Tool<any>[].
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: readonly Tool<any>[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    await this.start();
    const provider = buildProvider(this.config.ai);
    const session = await this.#client.createSession({
      availableTools: ['custom:*'],
      clientName: 'aspire-discord-bot',
      coauthorEnabled: false,
      customAgentsLocalOnly: true,
      embeddingCacheStorage: 'in-memory',
      enableConfigDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableOnDemandInstructionDiscovery: false,
      enableSessionStore: false,
      enableSkills: false,
      infiniteSessions: { enabled: false },
      manageScheduleEnabled: false,
      mcpOAuthTokenStorage: 'in-memory',
      model: this.config.ai.chatModel,
      ...(provider ? { provider } : {}),
      reasoningEffort: this.config.ai.reasoningEffort,
      sessionId: `discord-${crypto.randomUUID()}`,
      skipCustomInstructions: true,
      skipEmbeddingRetrieval: true,
      systemMessage: { mode: 'append', content: AGENT_SYSTEM_PROMPT },
      toolSearch: { enabled: false },
      tools: [...tools],
    });

    const abort = async () => {
      await session.abort().catch((error: unknown) => {
        this.logger.debug({ err: error, sessionId: session.sessionId }, 'Copilot abort failed.');
      });
    };
    let abortListener: (() => void) | undefined;
    const abortPromise = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            void abort();
            reject(abortReason(signal));
          };
          signal.addEventListener('abort', abortListener, { once: true });
          if (signal.aborted) {
            abortListener();
          }
        })
      : undefined;

    try {
      const completion = session.sendAndWait({ prompt }, this.config.agent.timeoutMs);
      const response = abortPromise
        ? await Promise.race([completion, abortPromise])
        : await completion;
      return response?.data.content.trim() ?? '';
    } catch (error) {
      await abort();
      throw error;
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
      await session.disconnect().catch((error: unknown) => {
        this.logger.warn(
          { err: error, sessionId: session.sessionId },
          'Copilot session disconnect failed.',
        );
      });
      await this.#client.deleteSession(session.sessionId).catch((error: unknown) => {
        this.logger.warn(
          { err: error, sessionId: session.sessionId },
          'Copilot session deletion failed.',
        );
      });
    }
  }

  async #forceCleanup(): Promise<void> {
    try {
      await this.#client.forceStop();
    } catch (cleanupError) {
      this.logger.warn(
        { err: cleanupError },
        'Failed to clean up a partially started Copilot runtime.',
      );
    } finally {
      this.#started = false;
      this.#startAttempted = false;
    }
  }
}

export function buildCopilotTelemetry(config: AppConfig): TelemetryConfig | undefined {
  if (!config.otlpEndpoint) {
    return undefined;
  }
  return {
    captureContent: config.nodeEnvironment === 'development',
    otlpEndpoint: config.otlpEndpoint,
    otlpProtocol: 'http/protobuf',
    sourceName: 'AspireDiscordBot.GenAI',
  };
}

export function buildProvider(config: AppConfig['ai']): ProviderConfig | undefined {
  switch (config.provider) {
    case 'copilot':
      return undefined;
    case 'azureopenai':
      return {
        apiKey: requireApiKey(config),
        baseUrl: requireEndpoint(config),
        maxOutputTokens: config.maxOutputTokens,
        modelId: config.chatModel,
        type: 'azure',
        wireApi: 'responses',
        wireModel: config.chatModel,
      };
    case 'azureaifoundry':
      return {
        bearerTokenProvider: getFoundryBearerToken,
        baseUrl: ensureFoundryV1Endpoint(requireEndpoint(config)),
        maxOutputTokens: config.maxOutputTokens,
        modelId: config.chatModel,
        type: 'openai',
        wireApi: 'responses',
        wireModel: config.chatModel,
      };
    case 'openai':
      return {
        apiKey: requireApiKey(config),
        baseUrl: ensureV1Endpoint(config.endpoint ?? 'https://api.openai.com'),
        maxOutputTokens: config.maxOutputTokens,
        modelId: config.chatModel,
        type: 'openai',
        wireApi: 'responses',
        wireModel: config.chatModel,
      };
    case 'ollama':
      return {
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        baseUrl: ensureV1Endpoint(config.endpoint ?? config.embeddingEndpoint),
        maxOutputTokens: config.maxOutputTokens,
        modelId: config.chatModel,
        type: 'openai',
        wireApi: 'completions',
        wireModel: config.chatModel,
      };
  }

  function requireApiKey(config: AppConfig['ai']): string {
    if (!config.apiKey) {
      throw new Error(`AI_API_KEY is required for ${config.provider}.`);
    }
    return config.apiKey;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.');
}

function requireEndpoint(config: AppConfig['ai']): string {
  if (!config.endpoint) {
    throw new Error(`AI_ENDPOINT is required for ${config.provider}.`);
  }
  return config.endpoint.replace(/\/+$/u, '');
}
