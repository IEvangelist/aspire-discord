import { describe, expect, it } from 'vitest';
import { CitationRegistry } from '../../src/citations.js';

describe('CitationRegistry', () => {
  it('keeps stable numbers across duplicate URLs', () => {
    const registry = new CitationRegistry();
    expect(registry.register('A', 'https://aspire.dev/a', 'aspire.dev')).toBe(1);
    expect(registry.register('Changed title', 'https://aspire.dev/a', 'aspire.dev')).toBe(1);
    expect(registry.all).toHaveLength(1);
  });

  it('formats and selects cited vector results', () => {
    const registry = new CitationRegistry();
    const output = registry.formatResults([
      {
        content: 'Use AddRedis.',
        path: 'redis.md',
        repo: 'microsoft/aspire.dev',
        score: 0.9,
        title: 'Redis',
        url: 'https://aspire.dev/caching/redis/',
      },
      {
        content: 'Use AddPostgres.',
        path: 'postgres.md',
        repo: 'microsoft/aspire.dev',
        score: 0.8,
        title: 'Postgres',
        url: 'https://aspire.dev/database/postgres/',
      },
    ]);

    expect(output).toContain('[1] Redis');
    expect(registry.citedBy('Only Redis [1].')).toEqual([registry.all[0]]);
  });

  it('handles empty results and falls back to all gathered citations', () => {
    const registry = new CitationRegistry();
    registry.register('One', 'https://aspire.dev/one', 'microsoft/aspire.dev');

    expect(registry.formatResults([])).toContain('No matching documentation');
    expect(registry.citedBy('Answer without a marker')).toEqual(registry.all);
  });

  it('bounds oversized tool evidence', () => {
    const registry = new CitationRegistry();
    const output = registry.formatResults(
      [
        {
          content: 'x'.repeat(100),
          heading: 'Heading',
          path: 'a.md',
          repo: 'microsoft/aspire.dev',
          score: 1,
          title: 'A',
          url: 'https://aspire.dev/a',
        },
      ],
      10,
    );

    expect(output).toContain('xxxxxxxxxx…');
  });
});
