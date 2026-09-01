import { describe, expect, it } from 'vitest';
import { RequestDeduplicator } from '../../src/discord/request-deduplicator.js';

describe('RequestDeduplicator', () => {
  it('claims each Discord delivery once within the retention window', () => {
    const deduplicator = new RequestDeduplicator(1_000, 10);

    expect(deduplicator.claim('request', 100)).toBe(true);
    expect(deduplicator.claim('request', 200)).toBe(false);
    expect(deduplicator.claim('request', 1_101)).toBe(true);
  });

  it('bounds retained delivery identifiers', () => {
    const deduplicator = new RequestDeduplicator(10_000, 2);

    expect(deduplicator.claim('one', 1)).toBe(true);
    expect(deduplicator.claim('two', 2)).toBe(true);
    expect(deduplicator.claim('three', 3)).toBe(true);
    expect(deduplicator.claim('one', 4)).toBe(true);
  });
});
