import { describe, expect, it } from 'vitest';
import { buildProvider } from '../../src/agent/copilot-runtime.js';
import { createTestConfig } from '../helpers/config.js';

describe('Copilot BYOK provider configuration', () => {
  it('passes the Azure resource host without appending an API route', () => {
    const config = createTestConfig({
      ai: {
        apiKey: 'credential',
        endpoint: 'https://example.openai.azure.com/',
        provider: 'azureopenai',
      },
    });

    expect(buildProvider(config.ai)?.baseUrl).toBe('https://example.openai.azure.com');
  });

  it('uses chat-completions for Ollama', () => {
    const config = createTestConfig({
      ai: {
        endpoint: 'http://localhost:11434',
        provider: 'ollama',
      },
    });

    expect(buildProvider(config.ai)).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      wireApi: 'completions',
    });
  });
});
