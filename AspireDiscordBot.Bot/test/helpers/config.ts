import type { AppConfig } from '../../src/config.js';

type ConfigOverrides = Omit<
  Partial<AppConfig>,
  | 'agent'
  | 'ai'
  | 'copilot'
  | 'discord'
  | 'githubMcp'
  | 'http'
  | 'qdrant'
  | 'retrieval'
  | 'safety'
  | 'vectorStore'
> & {
  agent?: Partial<AppConfig['agent']>;
  ai?: Partial<AppConfig['ai']>;
  copilot?: Partial<AppConfig['copilot']>;
  discord?: Partial<AppConfig['discord']>;
  githubMcp?: Partial<AppConfig['githubMcp']>;
  http?: Partial<AppConfig['http']>;
  qdrant?: Partial<AppConfig['qdrant']>;
  retrieval?: Partial<AppConfig['retrieval']>;
  safety?: Partial<AppConfig['safety']>;
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
      maxQuestionLength: 600,
      minTopicScore: 0.35,
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
    qdrant: { ...base.qdrant, ...overrides.qdrant },
    retrieval: { ...base.retrieval, ...overrides.retrieval },
    safety: { ...base.safety, ...overrides.safety },
    vectorStore: { ...base.vectorStore, ...overrides.vectorStore },
  };
}
