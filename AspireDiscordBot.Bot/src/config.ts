import { z } from 'zod';
import { parseIssuePolicy } from './issues/policy.js';
import { validateGitHubSigningKeyId } from './issues/keyvault-signer.js';
import type { IssuePolicy } from './issues/types.js';

const providerSchema = z.enum(['copilot', 'azureopenai', 'azureaifoundry', 'openai', 'ollama']);
const vectorStoreProviderSchema = z.enum(['azuresearch', 'qdrant']);
export const groundingDetailsModeSchema = z.enum(['collapsed', 'expanded', 'hidden']);
export type GroundingDetailsMode = z.infer<typeof groundingDetailsModeSchema>;

const rawEnvironmentSchema = z.object({
  AI_API_KEY: z.string().optional(),
  AI_CHAT_MODEL: z.string().min(1).default('gpt-5.6-sol'),
  AI_EMBEDDING_API_KEY: z.string().optional(),
  AI_EMBEDDING_API_VERSION: z.string().min(1).default('2024-10-21'),
  AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  AI_EMBEDDING_ENDPOINT: z.url(),
  AI_EMBEDDING_MODEL: z.string().min(1).optional(),
  AI_EMBEDDING_PROVIDER: providerSchema.default('azureaifoundry'),
  AI_ENDPOINT: z.url().optional().or(z.literal('')),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_768).default(2_000),
  AI_PROVIDER: providerSchema.default('copilot'),
  AI_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(30).default(10),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(90_000),
  AZURE_APPCONFIG_ENDPOINT: z.url().optional(),
  COPILOT_GITHUB_TOKEN: z.string().min(1).optional(),
  COPILOT_RUNTIME_BASE_PATH: z.string().min(1).optional(),
  DISCORD_ALLOWED_USER_IDS: z.string().default(''),
  DISCORD_GROUNDING_DETAILS_MODE: groundingDetailsModeSchema.default('collapsed'),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/).optional().or(z.literal('')),
  DISCORD_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  DISCORD_MAX_QUEUE: z.coerce.number().int().min(0).max(1_000).default(24),
  DISCORD_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(10),
  DISCORD_MENTION_ENABLED: z.string().default('true'),
  DISCORD_TOKEN: z.string().min(1).optional(),
  GITHUB_MCP_ENDPOINT: z.url().default('https://api.githubcopilot.com/mcp/'),
  GITHUB_MCP_TOKEN: z.string().min(1).optional(),
  GITHUB_ISSUES_APP_ID: z
    .string()
    .regex(/^[1-9]\d{0,19}$/u)
    .default('4968096'),
  GITHUB_ISSUES_KEY_ID: z
    .string()
    .superRefine((value, refinement) => {
      try {
        validateGitHubSigningKeyId(value);
      } catch {
        refinement.addIssue({
          code: 'custom',
          message:
            'Use a versioned HTTPS Azure Key Vault key URI, not a secret URI or key material.',
        });
      }
    })
    .optional()
    .or(z.literal('')),
  GITHUB_ISSUES_INSTALLATION_ID: z.coerce.number().int().positive().optional(),
  GITHUB_ISSUES_TABLE_ENDPOINT: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'Issue storage requires HTTPS.')
    .optional(),
  GITHUB_ISSUES_TABLE_NAME: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/u)
    .default('IssueDrafts'),
  GITHUB_ISSUES_POLICY: z.string().optional(),
  HOST: z.string().min(1).default('0.0.0.0'),
  IMAGE_CONTEXT_ENABLED: z.string().default('false'),
  IMAGE_CONTEXT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1_024)
    .max(10 * 1_024 * 1_024)
    .default(3 * 1_024 * 1_024),
  IMAGE_CONTEXT_MAX_IMAGES: z.coerce.number().int().min(1).max(2).default(1),
  IMAGE_CONTEXT_MAX_PIXELS: z.coerce
    .number()
    .int()
    .min(1_000_000)
    .max(40_000_000)
    .default(16_000_000),
  LINK_CONTEXT_ALLOWED_HOSTS: z
    .string()
    .default(
      'aspire.dev,learn.microsoft.com,devblogs.microsoft.com,dotnet.microsoft.com,azure.microsoft.com',
    ),
  LINK_CONTEXT_MAX_URLS: z.coerce.number().int().min(0).max(5).default(3),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  QDRANT_APIKEY: z.string().optional(),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_HTTPURI: z.url().optional(),
  QDRANT_URL: z.url().optional(),
  RETRIEVAL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.35),
  RETRIEVAL_RESULTS_PER_TOOL: z.coerce.number().int().min(1).max(20).default(6),
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
  RUNTIME_CONFIG_REFRESH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(300_000)
    .default(15_000),
  SAFETY_MAX_QUESTION_LENGTH: z.coerce.number().int().min(100).max(4_000).default(2_000),
  SAFETY_MIN_TOPIC_SCORE: z.coerce.number().min(0).max(1).default(0.35),
  TEXT_CONTEXT_ENABLED: z.string().default('true'),
  TEXT_CONTEXT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(1_024 * 1_024)
    .default(256 * 1_024),
  TEXT_CONTEXT_MAX_CHARACTERS: z.coerce.number().int().min(1_000).max(40_000).default(12_000),
  TEXT_CONTEXT_MAX_FILES: z.coerce.number().int().min(1).max(5).default(2),
  VECTOR_STORE_API_INDEX: z.string().min(1).default('aspire-api'),
  VECTOR_STORE_DOCS_INDEX: z.string().min(1).default('aspire-docs'),
  VECTOR_STORE_ENDPOINT: z.url().optional(),
  VECTOR_STORE_PROVIDER: vectorStoreProviderSchema.default('qdrant'),
});

export type AiProvider = z.infer<typeof providerSchema>;

export interface AppConfig {
  readonly agent: {
    readonly maxToolCalls: number;
    readonly timeoutMs: number;
  };
  readonly ai: {
    readonly apiKey?: string;
    readonly chatModel: string;
    readonly embeddingApiKey?: string;
    readonly embeddingApiVersion: string;
    readonly embeddingDimensions: number;
    readonly embeddingEndpoint: string;
    readonly embeddingModel: string;
    readonly embeddingProvider: AiProvider;
    readonly endpoint?: string;
    readonly maxOutputTokens: number;
    readonly provider: AiProvider;
    readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  readonly copilot: {
    readonly runtimeBasePath?: string;
    readonly token?: string;
  };
  readonly discord: {
    readonly allowedUserIds: ReadonlySet<string>;
    readonly groundingDetailsMode: GroundingDetailsMode;
    readonly guildId?: string;
    readonly maxConcurrency: number;
    readonly maxQueue: number;
    readonly maxRequestsPerMinute: number;
    readonly mentionEnabled: boolean;
    readonly token?: string;
  };
  readonly githubMcp: {
    readonly allowedRepositories: readonly ['microsoft/aspire', 'microsoft/aspire.dev'];
    readonly endpoint: string;
    readonly token?: string;
  };
  readonly issues: {
    readonly appId: string;
    readonly keyId?: string;
    readonly installationId?: number;
    readonly tableEndpoint?: string;
    readonly tableName: string;
    readonly policy: IssuePolicy;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
  };
  readonly imageContext: {
    readonly enabled: boolean;
    readonly maxBytes: number;
    readonly maxImages: number;
    readonly maxPixels: number;
  };
  readonly linkContext: {
    readonly allowedHosts: ReadonlySet<string>;
    readonly maxUrls: number;
  };
  readonly logLevel: z.infer<typeof rawEnvironmentSchema>['LOG_LEVEL'];
  readonly nodeEnvironment: z.infer<typeof rawEnvironmentSchema>['NODE_ENV'];
  readonly otlpEndpoint?: string;
  readonly qdrant: {
    readonly apiKey?: string;
    readonly apiCollection: string;
    readonly docsCollection: string;
    readonly url: string;
  };
  readonly retrieval: {
    readonly minScore: number;
    readonly resultsPerTool: number;
    readonly topK: number;
  };
  readonly runtimeConfig: {
    readonly endpoint?: string;
    readonly refreshIntervalMs: number;
  };
  readonly safety: {
    readonly maxQuestionLength: number;
    readonly minTopicScore: number;
  };
  readonly textContext: {
    readonly enabled: boolean;
    readonly maxBytes: number;
    readonly maxCharacters: number;
    readonly maxFiles: number;
  };
  readonly vectorStore: {
    readonly apiIndex: string;
    readonly docsIndex: string;
    readonly endpoint?: string;
    readonly provider: z.infer<typeof vectorStoreProviderSchema>;
  };
}

export class ConfigurationError extends Error {
  public constructor(issues: readonly z.core.$ZodIssue[]) {
    super(
      `Invalid service configuration: ${issues
        .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  if (environment.GITHUB_ISSUES_APP_PRIVATE_KEY !== undefined) {
    throw new ConfigurationError([
      {
        code: 'custom',
        path: ['GITHUB_ISSUES_APP_PRIVATE_KEY'],
        message:
          'Runtime PEM signing is not supported. Remove this setting and configure GITHUB_ISSUES_KEY_ID.',
      },
    ]);
  }
  const result = rawEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  const env = result.data;
  const qdrantUrl = env.QDRANT_URL ?? env.QDRANT_HTTPURI;
  if (env.VECTOR_STORE_PROVIDER === 'qdrant' && !qdrantUrl) {
    throw new ConfigurationError([
      {
        code: 'custom',
        input: undefined,
        message: 'QDRANT_URL or QDRANT_HTTPURI is required',
        path: ['QDRANT_URL'],
      },
    ]);
  }
  if (
    env.VECTOR_STORE_PROVIDER === 'azuresearch' &&
    (!env.VECTOR_STORE_ENDPOINT || new URL(env.VECTOR_STORE_ENDPOINT).protocol !== 'https:')
  ) {
    throw new ConfigurationError([
      {
        code: 'custom',
        input: undefined,
        message: 'Azure AI Search requires an HTTPS VECTOR_STORE_ENDPOINT',
        path: ['VECTOR_STORE_ENDPOINT'],
      },
    ]);
  }

  const allowedUserIds = parseIdentifierSet(env.DISCORD_ALLOWED_USER_IDS);
  const discordGuildId = env.DISCORD_GUILD_ID ? env.DISCORD_GUILD_ID : undefined;
  const mentionEnabled = parseBoolean(env.DISCORD_MENTION_ENABLED, 'DISCORD_MENTION_ENABLED');
  const imageContextEnabled = parseBoolean(env.IMAGE_CONTEXT_ENABLED, 'IMAGE_CONTEXT_ENABLED');
  const textContextEnabled = parseBoolean(env.TEXT_CONTEXT_ENABLED, 'TEXT_CONTEXT_ENABLED');
  const embeddingModel =
    env.AI_EMBEDDING_MODEL ??
    (env.AI_EMBEDDING_PROVIDER === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small');
  const embeddingDimensions =
    env.AI_EMBEDDING_DIMENSIONS ?? (env.AI_EMBEDDING_PROVIDER === 'ollama' ? 768 : 1_536);
  const sameProvider = env.AI_PROVIDER === env.AI_EMBEDDING_PROVIDER;
  const endpointsMatch =
    sameProvider &&
    env.AI_EMBEDDING_PROVIDER !== 'ollama' &&
    normalizeEndpoint(chatEndpoint(env.AI_PROVIDER, env.AI_ENDPOINT)) ===
      normalizeEndpoint(env.AI_EMBEDDING_ENDPOINT);
  const embeddingApiKey = env.AI_EMBEDDING_API_KEY ?? (endpointsMatch ? env.AI_API_KEY : undefined);
  const qdrantApiKey = env.QDRANT_API_KEY ?? env.QDRANT_APIKEY;
  const linkContextHosts = parseHostnameSet(env.LINK_CONTEXT_ALLOWED_HOSTS);

  if (
    env.AI_EMBEDDING_PROVIDER === 'azureaifoundry' &&
    new URL(env.AI_EMBEDDING_ENDPOINT).protocol !== 'https:'
  ) {
    throw new ConfigurationError([
      {
        code: 'custom',
        input: undefined,
        message: 'Azure AI Foundry embeddings require an HTTPS endpoint',
        path: ['AI_EMBEDDING_ENDPOINT'],
      },
    ]);
  }

  if (
    env.AI_EMBEDDING_PROVIDER !== 'ollama' &&
    env.AI_EMBEDDING_PROVIDER !== 'azureaifoundry' &&
    !embeddingApiKey
  ) {
    throw new ConfigurationError([
      {
        code: 'custom',
        input: undefined,
        message: `AI_EMBEDDING_API_KEY is required for ${env.AI_EMBEDDING_PROVIDER}`,
        path: ['AI_EMBEDDING_API_KEY'],
      },
    ]);
  }

  if (
    env.AI_PROVIDER !== 'copilot' &&
    env.AI_PROVIDER !== 'ollama' &&
    env.AI_PROVIDER !== 'azureaifoundry' &&
    !env.AI_API_KEY
  ) {
    throw new ConfigurationError([
      {
        code: 'custom',
        input: undefined,
        message: `AI_API_KEY is required for ${env.AI_PROVIDER}`,
        path: ['AI_API_KEY'],
      },
    ]);
  }

  return {
    agent: {
      maxToolCalls: env.AGENT_MAX_TOOL_CALLS,
      timeoutMs: env.AGENT_TIMEOUT_MS,
    },
    ai: {
      ...(env.AI_API_KEY ? { apiKey: env.AI_API_KEY } : {}),
      chatModel: env.AI_CHAT_MODEL,
      ...(embeddingApiKey ? { embeddingApiKey } : {}),
      embeddingApiVersion: env.AI_EMBEDDING_API_VERSION,
      embeddingDimensions,
      embeddingEndpoint: env.AI_EMBEDDING_ENDPOINT,
      embeddingModel,
      embeddingProvider: env.AI_EMBEDDING_PROVIDER,
      ...(env.AI_ENDPOINT ? { endpoint: env.AI_ENDPOINT } : {}),
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      provider: env.AI_PROVIDER,
      reasoningEffort: env.AI_REASONING_EFFORT,
    },
    copilot: {
      ...(env.COPILOT_RUNTIME_BASE_PATH ? { runtimeBasePath: env.COPILOT_RUNTIME_BASE_PATH } : {}),
      ...(env.COPILOT_GITHUB_TOKEN ? { token: env.COPILOT_GITHUB_TOKEN } : {}),
    },
    discord: {
      allowedUserIds,
      groundingDetailsMode: env.DISCORD_GROUNDING_DETAILS_MODE,
      ...(discordGuildId ? { guildId: discordGuildId } : {}),
      maxConcurrency: env.DISCORD_MAX_CONCURRENCY,
      maxQueue: env.DISCORD_MAX_QUEUE,
      maxRequestsPerMinute: env.DISCORD_MAX_REQUESTS_PER_MINUTE,
      mentionEnabled,
      ...(env.DISCORD_TOKEN ? { token: env.DISCORD_TOKEN } : {}),
    },
    githubMcp: {
      allowedRepositories: ['microsoft/aspire', 'microsoft/aspire.dev'],
      endpoint: env.GITHUB_MCP_ENDPOINT,
      ...(env.GITHUB_MCP_TOKEN ? { token: env.GITHUB_MCP_TOKEN } : {}),
    },
    issues: {
      appId: env.GITHUB_ISSUES_APP_ID,
      ...(env.GITHUB_ISSUES_KEY_ID
        ? { keyId: validateGitHubSigningKeyId(env.GITHUB_ISSUES_KEY_ID) }
        : {}),
      ...(env.GITHUB_ISSUES_INSTALLATION_ID
        ? { installationId: env.GITHUB_ISSUES_INSTALLATION_ID }
        : {}),
      ...(env.GITHUB_ISSUES_TABLE_ENDPOINT
        ? { tableEndpoint: env.GITHUB_ISSUES_TABLE_ENDPOINT }
        : {}),
      tableName: env.GITHUB_ISSUES_TABLE_NAME,
      policy: parseIssuePolicy(env.GITHUB_ISSUES_POLICY),
    },
    http: {
      host: env.HOST,
      port: env.PORT,
    },
    imageContext: {
      enabled: imageContextEnabled,
      maxBytes: env.IMAGE_CONTEXT_MAX_BYTES,
      maxImages: env.IMAGE_CONTEXT_MAX_IMAGES,
      maxPixels: env.IMAGE_CONTEXT_MAX_PIXELS,
    },
    linkContext: {
      allowedHosts: linkContextHosts,
      maxUrls: env.LINK_CONTEXT_MAX_URLS,
    },
    logLevel: env.LOG_LEVEL,
    nodeEnvironment: env.NODE_ENV,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    qdrant: {
      ...(qdrantApiKey ? { apiKey: qdrantApiKey } : {}),
      apiCollection: 'aspire_api',
      docsCollection: 'aspire_docs',
      url: qdrantUrl ?? '',
    },
    retrieval: {
      minScore: env.RETRIEVAL_MIN_SCORE,
      resultsPerTool: env.RETRIEVAL_RESULTS_PER_TOOL,
      topK: env.RETRIEVAL_TOP_K,
    },
    runtimeConfig: {
      ...(env.AZURE_APPCONFIG_ENDPOINT ? { endpoint: env.AZURE_APPCONFIG_ENDPOINT } : {}),
      refreshIntervalMs: env.RUNTIME_CONFIG_REFRESH_INTERVAL_MS,
    },
    safety: {
      maxQuestionLength: env.SAFETY_MAX_QUESTION_LENGTH,
      minTopicScore: env.SAFETY_MIN_TOPIC_SCORE,
    },
    textContext: {
      enabled: textContextEnabled,
      maxBytes: env.TEXT_CONTEXT_MAX_BYTES,
      maxCharacters: env.TEXT_CONTEXT_MAX_CHARACTERS,
      maxFiles: env.TEXT_CONTEXT_MAX_FILES,
    },
    vectorStore: {
      apiIndex: env.VECTOR_STORE_API_INDEX,
      docsIndex: env.VECTOR_STORE_DOCS_INDEX,
      ...(env.VECTOR_STORE_ENDPOINT ? { endpoint: env.VECTOR_STORE_ENDPOINT } : {}),
      provider: env.VECTOR_STORE_PROVIDER,
    },
  };
}

function parseBoolean(value: string, name: string): boolean {
  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }
  throw new ConfigurationError([
    {
      code: 'custom',
      input: value,
      message: `${name} must be true or false`,
      path: [name],
    },
  ]);
}

export function parseIdentifierSet(value: unknown): ReadonlySet<string> {
  if (typeof value === 'string' && !value.trim()) {
    return new Set();
  }

  const values: unknown =
    typeof value === 'string'
      ? value.trim().startsWith('[')
        ? JSON.parse(value.trim())
        : value.split(',').map((item) => item.trim())
      : value;
  const parsed = z.array(z.string().regex(/^\d+$/)).parse(values);
  return new Set(parsed);
}

function parseHostnameSet(value: string): ReadonlySet<string> {
  const hosts = value
    .split(',')
    .map((item) => item.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean);
  const parsed = z
    .array(
      z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u),
    )
    .parse(hosts);
  return new Set(parsed);
}

function chatEndpoint(provider: AiProvider, configured: string | undefined): string {
  if (configured) {
    return configured;
  }
  return provider === 'openai' ? 'https://api.openai.com' : '';
}

function normalizeEndpoint(value: string): string {
  if (!value) {
    return '';
  }
  const endpoint = new URL(value);
  const path = endpoint.pathname.replace(/\/+$/u, '');
  return `${endpoint.protocol}//${endpoint.host}${path}${endpoint.search}`;
}
