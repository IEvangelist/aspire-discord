import { describe, expect, it } from 'vitest';
import { ensureFoundryV1Endpoint, ensureV1Endpoint } from '../../src/agent/embeddings.js';

describe('embedding endpoint normalization', () => {
  it('builds a Microsoft Foundry v1 endpoint from a resource endpoint', () => {
    expect(ensureFoundryV1Endpoint('https://example.openai.azure.com/')).toBe(
      'https://example.openai.azure.com/openai/v1',
    );
  });

  it('does not duplicate existing API paths', () => {
    expect(ensureFoundryV1Endpoint('https://example.openai.azure.com/openai/v1/')).toBe(
      'https://example.openai.azure.com/openai/v1',
    );
    expect(ensureFoundryV1Endpoint('https://example.openai.azure.com/OpenAI/V1/')).toBe(
      'https://example.openai.azure.com/OpenAI/V1',
    );
    expect(ensureV1Endpoint('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
  });
});
