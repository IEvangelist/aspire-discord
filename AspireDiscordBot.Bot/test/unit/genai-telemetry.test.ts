import { describe, expect, it } from 'vitest';
import { operationAttributes, providerName } from '../../src/genai-telemetry.js';

describe('GenAI telemetry conventions', () => {
  it('maps Microsoft Foundry to the Azure OpenAI convention', () => {
    expect(providerName('azureaifoundry')).toBe('azure.ai.openai');
  });

  it('emits the attributes Aspire uses to recognize GenAI spans', () => {
    expect(
      operationAttributes({
        model: 'text-embedding-3-small',
        operation: 'embeddings',
        provider: 'azureaifoundry',
        serverAddress: 'example.openai.azure.com',
      }),
    ).toMatchObject({
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.provider.name': 'azure.ai.openai',
      'gen_ai.request.model': 'text-embedding-3-small',
      'gen_ai.system': 'azure.ai.openai',
      'server.address': 'example.openai.azure.com',
    });
  });
});
