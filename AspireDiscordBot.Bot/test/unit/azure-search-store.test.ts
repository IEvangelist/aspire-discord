import { describe, expect, it } from 'vitest';
import { azureSearchScoreToCosineSimilarity } from '../../src/agent/azure-search-store.js';

describe('Azure AI Search score normalization', () => {
  it('converts Azure cosine scores back to cosine similarity', () => {
    expect(azureSearchScoreToCosineSimilarity(1)).toBe(1);
    expect(azureSearchScoreToCosineSimilarity(0.5)).toBe(0);
    expect(azureSearchScoreToCosineSimilarity(1 / 3)).toBeCloseTo(-1);
  });

  it('bounds invalid and floating-point edge scores', () => {
    expect(azureSearchScoreToCosineSimilarity(0)).toBe(-1);
    expect(azureSearchScoreToCosineSimilarity(Number.NaN)).toBe(-1);
    expect(azureSearchScoreToCosineSimilarity(2)).toBe(1);
  });
});
