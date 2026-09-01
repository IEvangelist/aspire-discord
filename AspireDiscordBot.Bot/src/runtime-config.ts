import { AppConfigurationClient } from '@azure/app-configuration';
import { DefaultAzureCredential } from '@azure/identity';
import { metrics } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import {
  groundingDetailsModeSchema,
  parseIdentifierSet,
  type AppConfig,
  type GroundingDetailsMode,
} from './config.js';

export const runtimeConfigKeys = {
  allowedUserIds: 'AspireDiscord:Discord:AllowedUserIds',
  groundingDetailsMode: 'AspireDiscord:Discord:GroundingDetailsMode',
} as const;

const runtimeConfigPrefix = 'AspireDiscord:Discord:';
const requestTimeoutMilliseconds = 5_000;
const meter = metrics.getMeter('AspireDiscordBot.RuntimeConfig');
const refreshes = meter.createCounter('aspire.runtime_config.refreshes', {
  description: 'Runtime configuration refresh attempts by outcome.',
  unit: '{refresh}',
});

export interface RuntimeConfigSnapshot {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly available: boolean;
  readonly groundingDetailsMode: GroundingDetailsMode;
  readonly revision: string;
  readonly source: 'azure-app-configuration' | 'environment' | 'unavailable';
}

export interface RuntimeConfig {
  current(): RuntimeConfigSnapshot;
  refresh(): Promise<void>;
  stop(): void;
}

interface RuntimeConfigDependencies {
  readonly client?: RuntimeConfigClient;
}

interface RuntimeSetting {
  readonly key: string;
  readonly value?: string;
}

interface RuntimeConfigClient {
  listSettings(signal: AbortSignal): AsyncIterable<RuntimeSetting>;
}

export async function startRuntimeConfig(
  config: Pick<AppConfig, 'discord' | 'runtimeConfig'>,
  logger: Logger,
  dependencies: RuntimeConfigDependencies = {},
): Promise<RuntimeConfig> {
  const fallback = snapshot(
    config.discord.allowedUserIds,
    config.discord.groundingDetailsMode,
    'environment',
    true,
  );
  if (!config.runtimeConfig.endpoint) {
    logger.info(
      {
        allowedUserCount: fallback.allowedUserIds.size,
        groundingDetailsMode: fallback.groundingDetailsMode,
        runtimeConfigSource: fallback.source,
      },
      'Using environment-backed runtime configuration.',
    );
    return new StaticRuntimeConfig(fallback);
  }

  const runtime = new RefreshingRuntimeConfig(
    snapshot(new Set(), fallback.groundingDetailsMode, 'unavailable', false),
    config.runtimeConfig.refreshIntervalMs,
    logger,
    dependencies.client ??
      new AzureRuntimeConfigClient(config.runtimeConfig.endpoint, new DefaultAzureCredential()),
  );
  await runtime.start();
  return runtime;
}

class StaticRuntimeConfig implements RuntimeConfig {
  public constructor(private readonly value: RuntimeConfigSnapshot) {}

  public current(): RuntimeConfigSnapshot {
    return this.value;
  }

  public refresh(): Promise<void> {
    return Promise.resolve();
  }

  public stop(): void {
    return undefined;
  }
}

class RefreshingRuntimeConfig implements RuntimeConfig {
  #consecutiveFailures = 0;
  #refreshInFlight: Promise<void> | undefined;
  #snapshot: RuntimeConfigSnapshot;
  #timer: NodeJS.Timeout | undefined;

  public constructor(
    fallback: RuntimeConfigSnapshot,
    private readonly refreshIntervalMs: number,
    private readonly logger: Logger,
    private readonly client: RuntimeConfigClient,
  ) {
    this.#snapshot = fallback;
  }

  public async start(): Promise<void> {
    await this.refresh();
    this.#timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    this.#timer.unref();
  }

  public current(): RuntimeConfigSnapshot {
    return this.#snapshot;
  }

  public refresh(): Promise<void> {
    this.#refreshInFlight ??= this.#refresh().finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  public stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #refresh(): Promise<void> {
    try {
      const configuration = new Map<string, unknown>();
      for await (const setting of this.client.listSettings(
        AbortSignal.timeout(requestTimeoutMilliseconds),
      )) {
        configuration.set(setting.key, setting.value);
      }
      const changed = this.#apply(configuration);
      this.#consecutiveFailures = 0;
      refreshes.add(1, {
        'aspire.runtime_config.refresh.outcome': changed ? 'updated' : 'unchanged',
      });
    } catch (error) {
      this.#consecutiveFailures++;
      refreshes.add(1, { 'aspire.runtime_config.refresh.outcome': 'failed' });
      if (this.#consecutiveFailures === 1 || this.#consecutiveFailures % 20 === 0) {
        this.logger.warn(
          {
            consecutiveFailures: this.#consecutiveFailures,
            err: error,
            runtimeConfigSource: this.#snapshot.source,
          },
          'Could not refresh runtime configuration; retaining the last valid values.',
        );
      }
    }
  }

  #apply(configuration: ReadonlyMap<string, unknown>): boolean {
    const allowedUserIds = parseIdentifierSet(
      requiredSetting(configuration, runtimeConfigKeys.allowedUserIds),
    );
    const groundingDetailsMode = groundingDetailsModeSchema.parse(
      requiredSetting(configuration, runtimeConfigKeys.groundingDetailsMode),
    );
    const next = snapshot(allowedUserIds, groundingDetailsMode, 'azure-app-configuration', true);
    if (next.revision === this.#snapshot.revision && next.source === this.#snapshot.source) {
      return false;
    }
    this.#snapshot = next;
    this.logger.info(
      {
        allowedUserCount: next.allowedUserIds.size,
        groundingDetailsMode: next.groundingDetailsMode,
        runtimeConfigRevision: next.revision,
        runtimeConfigSource: next.source,
      },
      'Applied refreshed runtime configuration.',
    );
    return true;
  }
}

class AzureRuntimeConfigClient implements RuntimeConfigClient {
  readonly #client: AppConfigurationClient;

  public constructor(endpoint: string, credential: DefaultAzureCredential) {
    this.#client = new AppConfigurationClient(endpoint, credential);
  }

  public listSettings(signal: AbortSignal): AsyncIterable<RuntimeSetting> {
    return this.#client.listConfigurationSettings({
      abortSignal: signal,
      fields: ['key', 'value'],
      keyFilter: `${runtimeConfigPrefix}*`,
      labelFilter: '\0',
    });
  }
}

function requiredSetting(configuration: ReadonlyMap<string, unknown>, key: string): unknown {
  const value = configuration.get(key);
  if (value === undefined || value === null) {
    throw new Error(`Runtime configuration setting '${key}' is missing.`);
  }
  return value;
}

function snapshot(
  allowedUserIds: ReadonlySet<string>,
  groundingDetailsMode: GroundingDetailsMode,
  source: RuntimeConfigSnapshot['source'],
  available: boolean,
): RuntimeConfigSnapshot {
  const normalizedIds = [...allowedUserIds].sort();
  const revision = createHash('sha256')
    .update(JSON.stringify({ allowedUserIds: normalizedIds, groundingDetailsMode }))
    .digest('hex')
    .slice(0, 12);
  return {
    allowedUserIds: new Set(normalizedIds),
    available,
    groundingDetailsMode,
    revision,
    source,
  };
}
