import { describe, expect, it } from 'vitest';
import {
  buildCopilotTelemetry,
  buildProvider,
  validateImageModel,
} from '../../src/agent/copilot-runtime.js';
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
    expect(
      buildCopilotTelemetry(
        createTestConfig({
          imageContext: { enabled: true },
          nodeEnvironment: 'development',
          otlpEndpoint: 'http://localhost:4318',
        }),
      )?.captureContent,
    ).toBe(false);
    expect(buildCopilotTelemetry(createTestConfig())).toBeUndefined();
  });

  it('enforces advertised model image capabilities and limits', () => {
    const image = {
      data: Buffer.from('image').toString('base64'),
      displayName: 'image.jpg',
      mimeType: 'image/jpeg' as const,
    };
    const model = {
      capabilities: {
        limits: {
          max_context_window_tokens: 100_000,
          vision: {
            max_prompt_image_size: 1_024,
            max_prompt_images: 1,
            supported_media_types: ['image/jpeg'],
          },
        },
        supports: { reasoningEffort: true, vision: true },
      },
      id: 'vision-model',
      name: 'Vision model',
    };

    expect(() => validateImageModel(model, [image])).not.toThrow();
    expect(() =>
      validateImageModel(
        {
          ...model,
          capabilities: {
            ...model.capabilities,
            supports: { ...model.capabilities.supports, vision: false },
          },
        },
        [image],
      ),
    ).toThrow(/does not support/u);
    expect(() => validateImageModel(model, [image, image])).toThrow(/too many/iu);
  });
});
