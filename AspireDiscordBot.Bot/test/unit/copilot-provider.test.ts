import { describe, expect, it } from 'vitest';
import { buildCopilotTelemetry, buildProvider } from '../../src/agent/copilot-runtime.js';
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

  it('uses managed identity for Microsoft Foundry', () => {
    const config = createTestConfig({
      ai: {
        endpoint: 'https://example.openai.azure.com/',
        provider: 'azureaifoundry',
      },
    });

    const provider = buildProvider(config.ai);

    expect(provider).toMatchObject({
      baseUrl: 'https://example.openai.azure.com/openai/v1',
      type: 'openai',
      wireApi: 'responses',
    });
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.bearerTokenProvider).toBeTypeOf('function');
  });

  it('captures message content only for the local development dashboard', () => {
    const development = createTestConfig({
      nodeEnvironment: 'development',
      otlpEndpoint: 'http://localhost:4318',
    });
    const production = createTestConfig({
      nodeEnvironment: 'production',
      otlpEndpoint: 'http://collector:4318',
    });

    expect(buildCopilotTelemetry(development)?.captureContent).toBe(true);
    expect(buildCopilotTelemetry(production)?.captureContent).toBe(false);
    expect(buildCopilotTelemetry(createTestConfig())).toBeUndefined();
  });
});
