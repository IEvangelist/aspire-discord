import type { AppConfig } from '../../src/config.js';

type ConfigOverrides = Omit<
  Partial<AppConfig>,
  | 'agent'
  | 'ai'
  | 'copilot'
  | 'discord'
  | 'githubMcp'
  | 'http'
  | 'imageContext'
  | 'linkContext'
  | 'qdrant'
  | 'retrieval'
  | 'safety'
  | 'textContext'
  | 'vectorStore'
> & {
  agent?: Partial<AppConfig['agent']>;
  ai?: Partial<AppConfig['ai']>;
  copilot?: Partial<AppConfig['copilot']>;
  discord?: Partial<AppConfig['discord']>;
  githubMcp?: Partial<AppConfig['githubMcp']>;
  http?: Partial<AppConfig['http']>;
  imageContext?: Partial<AppConfig['imageContext']>;
  linkContext?: Partial<AppConfig['linkContext']>;
  qdrant?: Partial<AppConfig['qdrant']>;
  retrieval?: Partial<AppConfig['retrieval']>;
  safety?: Partial<AppConfig['safety']>;
  textContext?: Partial<AppConfig['textContext']>;
  vectorStore?: Partial<AppConfig['vectorStore']>;
};

export function createTestConfig(overrides: ConfigOverrides = {}): AppConfig {
  const base: AppConfig = {
    agent: {
      maxToolCalls: 10,
      timeoutMs: 10_000,
    },
    ai: {
      chatModel: 'gpt-5.6-sol',
      embeddingApiVersion: '2024-10-21',
      embeddingDimensions: 3,
      embeddingEndpoint: 'http://127.0.0.1:11434',
      embeddingModel: 'test-embedding',
      embeddingProvider: 'ollama',
      maxOutputTokens: 2_000,
      provider: 'copilot',
      reasoningEffort: 'low',
    },
    copilot: {},
    discord: {
      allowedUserIds: new Set(),
      maxConcurrency: 2,
      maxQueue: 4,
      maxRequestsPerMinute: 10,
      mentionEnabled: false,
    },
    githubMcp: {
      allowedRepositories: ['microsoft/aspire', 'microsoft/aspire.dev'],
      endpoint: 'https://api.githubcopilot.com/mcp/',
    },
    http: {
      host: '127.0.0.1',
      port: 3_000,
    },
    imageContext: {
      enabled: false,
      maxBytes: 3 * 1_024 * 1_024,
      maxImages: 1,
      maxPixels: 16_000_000,
    },
    linkContext: {
      allowedHosts: new Set([
        'aspire.dev',
        'learn.microsoft.com',
        'devblogs.microsoft.com',
        'dotnet.microsoft.com',
        'azure.microsoft.com',
      ]),
      maxUrls: 3,
    },
    logLevel: 'silent',
    nodeEnvironment: 'test',
    qdrant: {
      apiCollection: 'aspire_api',
      docsCollection: 'aspire_docs',
      url: 'http://127.0.0.1:6333',
    },
    retrieval: {
      minScore: 0.35,
      resultsPerTool: 6,
      topK: 6,
    },
    safety: {
      maxQuestionLength: 2_000,
      minTopicScore: 0.35,
    },
    textContext: {
      enabled: true,
      maxBytes: 256 * 1_024,
      maxCharacters: 12_000,
      maxFiles: 2,
    },
    vectorStore: {
      apiIndex: 'aspire-api',
      docsIndex: 'aspire-docs',
      provider: 'qdrant',
    },
  };
  return {
    ...base,
    ...overrides,
    agent: { ...base.agent, ...overrides.agent },
    ai: { ...base.ai, ...overrides.ai },
    copilot: { ...base.copilot, ...overrides.copilot },
    discord: { ...base.discord, ...overrides.discord },
    githubMcp: { ...base.githubMcp, ...overrides.githubMcp },
    http: { ...base.http, ...overrides.http },
    imageContext: { ...base.imageContext, ...overrides.imageContext },
    linkContext: { ...base.linkContext, ...overrides.linkContext },
    qdrant: { ...base.qdrant, ...overrides.qdrant },
    retrieval: { ...base.retrieval, ...overrides.retrieval },
    safety: { ...base.safety, ...overrides.safety },
    textContext: { ...base.textContext, ...overrides.textContext },
    vectorStore: { ...base.vectorStore, ...overrides.vectorStore },
  };
}
