import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config.js';

const validEnvironment = {
  AI_EMBEDDING_ENDPOINT: 'https://example.openai.azure.com',
  QDRANT_URL: 'http://localhost:6333',
};

describe('loadConfig', () => {
  it('loads hosted Foundry defaults', () => {
    const config = loadConfig(validEnvironment);

    expect(config.ai.provider).toBe('copilot');
    expect(config.ai.embeddingProvider).toBe('azureaifoundry');
    expect(config.ai.embeddingModel).toBe('text-embedding-3-small');
    expect(config.ai.embeddingDimensions).toBe(1_536);
    expect(config.discord.mentionEnabled).toBe(true);
    expect(config.discord.maxRequestsPerMinute).toBe(10);
    expect(config.imageContext).toEqual({
      enabled: false,
      maxBytes: 3 * 1_024 * 1_024,
      maxImages: 1,
      maxPixels: 16_000_000,
    });
    expect(config.safety.maxQuestionLength).toBe(2_000);
    expect(config.textContext).toEqual({
      enabled: true,
      maxBytes: 256 * 1_024,
      maxCharacters: 12_000,
      maxFiles: 2,
    });
    expect(config.linkContext.allowedHosts.has('aspire.dev')).toBe(true);
    expect(config.linkContext.maxUrls).toBe(3);
    expect(config.qdrant.url).toBe('http://localhost:6333');
  });

  it('enables bounded image context only when explicitly configured', () => {
    const config = loadConfig({
      ...validEnvironment,
      IMAGE_CONTEXT_ENABLED: 'true',
      IMAGE_CONTEXT_MAX_BYTES: '1048576',
      IMAGE_CONTEXT_MAX_IMAGES: '1',
      IMAGE_CONTEXT_MAX_PIXELS: '2000000',
    });

    expect(config.imageContext).toEqual({
      enabled: true,
      maxBytes: 1_048_576,
      maxImages: 1,
      maxPixels: 2_000_000,
    });
  });

  it('configures bounded text attachment context', () => {
    const config = loadConfig({
      ...validEnvironment,
      TEXT_CONTEXT_ENABLED: 'false',
      TEXT_CONTEXT_MAX_BYTES: '32768',
      TEXT_CONTEXT_MAX_CHARACTERS: '4000',
      TEXT_CONTEXT_MAX_FILES: '1',
    });

    expect(config.textContext).toEqual({
      enabled: false,
      maxBytes: 32_768,
      maxCharacters: 4_000,
      maxFiles: 1,
    });
  });

  it('requires exact hostnames for linked context', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        LINK_CONTEXT_ALLOWED_HOSTS: '*.microsoft.com',
      }),
    ).toThrow();
  });

  it('uses Ollama defaults only when explicitly selected', () => {
    const config = loadConfig({
      ...validEnvironment,
      AI_EMBEDDING_ENDPOINT: 'http://localhost:11434',
      AI_EMBEDDING_PROVIDER: 'ollama',
    });

    expect(config.ai.embeddingProvider).toBe('ollama');
    expect(config.ai.embeddingModel).toBe('nomic-embed-text');
    expect(config.ai.embeddingDimensions).toBe(768);
  });

  it('requires HTTPS for Foundry embeddings', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        AI_EMBEDDING_ENDPOINT: 'http://example.openai.azure.com',
      }),
    ).toThrow(/HTTPS endpoint/u);
  });

  it('allows Foundry chat without an API key', () => {
    const config = loadConfig({
      ...validEnvironment,
      AI_ENDPOINT: 'https://example.openai.azure.com',
      AI_PROVIDER: 'azureaifoundry',
    });

    expect(config.ai.apiKey).toBeUndefined();
    expect(config.ai.provider).toBe('azureaifoundry');
  });

  it('parses comma-separated and JSON user allow lists', () => {
    const csv = loadConfig({
      ...validEnvironment,
      DISCORD_ALLOWED_USER_IDS: '123, 456',
    });
    const json = loadConfig({
      ...validEnvironment,
      DISCORD_ALLOWED_USER_IDS: '["789"]',
    });

    expect([...csv.discord.allowedUserIds]).toEqual(['123', '456']);
    expect([...json.discord.allowedUserIds]).toEqual(['789']);
  });

  it('does not reuse a chat key for a different embedding provider', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        AI_API_KEY: 'chat-secret',
        AI_EMBEDDING_PROVIDER: 'openai',
        AI_PROVIDER: 'azureopenai',
      }),
    ).toThrow(/AI_EMBEDDING_API_KEY/u);
  });

  it('allows one key to serve the same chat and embedding provider', () => {
    const config = loadConfig({
      ...validEnvironment,
      AI_API_KEY: 'shared',
      AI_ENDPOINT: 'http://localhost:11434',
      AI_EMBEDDING_ENDPOINT: 'http://localhost:11434',
      AI_EMBEDDING_PROVIDER: 'openai',
      AI_PROVIDER: 'openai',
    });

    expect(config.ai.embeddingApiKey).toBe('shared');
  });

  it('does not inherit credentials across different endpoints', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        AI_API_KEY: 'chat-only',
        AI_ENDPOINT: 'https://api.openai.com',
        AI_EMBEDDING_PROVIDER: 'openai',
        AI_PROVIDER: 'openai',
      }),
    ).toThrow(/AI_EMBEDDING_API_KEY/u);
  });

  it('requires a Qdrant endpoint', () => {
    expect(() => loadConfig({ AI_EMBEDDING_ENDPOINT: 'http://localhost:11434' })).toThrow(
      /QDRANT_URL/u,
    );
  });

  it('supports Azure AI Search without a Qdrant endpoint', () => {
    const config = loadConfig({
      AI_EMBEDDING_ENDPOINT: 'https://example.openai.azure.com',
      VECTOR_STORE_ENDPOINT: 'https://example.search.windows.net',
      VECTOR_STORE_PROVIDER: 'azuresearch',
    });

    expect(config.vectorStore).toMatchObject({
      apiIndex: 'aspire-api',
      docsIndex: 'aspire-docs',
      endpoint: 'https://example.search.windows.net',
      provider: 'azuresearch',
    });
  });

  it('rejects malformed booleans without exposing secrets', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        DISCORD_MENTION_ENABLED: 'sometimes',
        DISCORD_TOKEN: 'super-secret',
      }),
    ).toThrow(ConfigurationError);

    try {
      loadConfig({
        ...validEnvironment,
        DISCORD_MENTION_ENABLED: 'sometimes',
        DISCORD_TOKEN: 'super-secret',
      });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
    }
  });
});
