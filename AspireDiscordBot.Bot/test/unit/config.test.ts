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
    expect(config.qdrant.url).toBe('http://localhost:6333');
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
