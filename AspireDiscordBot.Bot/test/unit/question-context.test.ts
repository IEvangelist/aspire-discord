import { afterEach, describe, expect, it, vi } from 'vitest';
import { CitationRegistry } from '../../src/citations.js';
import {
  extractQuestionUrls,
  isContextualLatestReleaseQuestion,
  QuestionContextResolver,
  type LinkedGitHubContextProvider,
} from '../../src/agent/question-context.js';
import { ToolBudget } from '../../src/agent/tool-budget.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function github(overrides: Partial<LinkedGitHubContextProvider> = {}): LinkedGitHubContextProvider {
  return {
    readLatestReleaseContext: vi.fn(async () => undefined),
    readLinkedContext: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('QuestionContextResolver', () => {
  it('resolves latest-version questions through live GitHub release context', async () => {
    const readLatestReleaseContext = vi.fn(async () => ({
      context: '[1] Aspire 13.5.3',
      releaseCitationNumber: 1,
      releaseVersion: '13.5.3',
      searchText: 'Aspire 13.5.3 released August 25, 2026',
    }));
    const resolver = new QuestionContextResolver(
      createTestConfig().linkContext,
      github({ readLatestReleaseContext }),
      testLogger,
    );

    const result = await resolver.resolve(
      'What is the latest version of Aspire?',
      new CitationRegistry(),
      new ToolBudget(10),
    );

    expect(readLatestReleaseContext).toHaveBeenCalledOnce();
    expect(result.context).toContain('13.5.3');
    expect(result.liveRelease).toBe('resolved');
    expect(result.latestRelease).toEqual({ citationNumber: 1, version: '13.5.3' });
    expect(result.resolvedCount).toBe(1);
    expect(result.topicEvidenceCount).toBe(1);
  });

  it('routes GitHub links through MCP and official links through bounded fetch', async () => {
    const readLinkedContext = vi.fn(async () => ({
      context: '[1] Linked issue context',
      searchText: 'Issue discusses AddRedis',
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<title>Redis docs</title><p>Use AddRedis.</p>', {
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const resolver = new QuestionContextResolver(
      createTestConfig().linkContext,
      github({ readLinkedContext }),
      testLogger,
    );

    const result = await resolver.resolve(
      'Compare https://github.com/microsoft/aspire/issues/123 and https://aspire.dev/caching/redis/.',
      new CitationRegistry(),
      new ToolBudget(10),
    );

    expect(readLinkedContext).toHaveBeenCalledWith(
      'https://github.com/microsoft/aspire/issues/123',
      expect.any(CitationRegistry),
      expect.any(ToolBudget),
      undefined,
    );
    expect(result.context).toContain('Linked issue context');
    expect(result.context).toContain('Use AddRedis.');
    expect(result.resolvedCount).toBe(2);
    expect(result.topicEvidenceCount).toBe(2);
  });

  it('does not fetch hosts outside the exact allowlist', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new QuestionContextResolver(
      createTestConfig().linkContext,
      github(),
      testLogger,
    );

    const result = await resolver.resolve(
      'See https://evil.aspire.dev/context',
      new CitationRegistry(),
      new ToolBudget(10),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.resolvedCount).toBe(0);
    expect(result.topicEvidenceCount).toBe(0);
  });

  it('resolves approved links found in relevant conversation observations', async () => {
    const readLinkedContext = vi.fn(async () => ({
      context: '[1] Linked issue context',
      searchText: 'Issue discusses deployment',
    }));
    const resolver = new QuestionContextResolver(
      createTestConfig().linkContext,
      github({ readLinkedContext }),
      testLogger,
    );

    await resolver.resolve(
      'Does that explain the behavior?',
      new CitationRegistry(),
      new ToolBudget(10),
      undefined,
      '[Original poster]\nSee https://github.com/microsoft/aspire/issues/123',
    );

    expect(readLinkedContext).toHaveBeenCalledOnce();
  });

  it('prioritizes direct links and budgets at most one observation-derived link', async () => {
    const readLinkedContext = vi.fn(async (value: string) => ({
      context: `[1] ${value}`,
      searchText: value,
    }));
    const resolver = new QuestionContextResolver(
      { ...createTestConfig().linkContext, maxUrls: 3 },
      github({ readLinkedContext }),
      testLogger,
    );

    await resolver.resolve(
      'Compare https://github.com/microsoft/aspire/issues/1 and https://github.com/microsoft/aspire/issues/2',
      new CitationRegistry(),
      new ToolBudget(10),
      undefined,
      'Older context https://github.com/microsoft/aspire/issues/3 https://github.com/microsoft/aspire/issues/4',
    );

    expect(readLinkedContext.mock.calls.map(([value]) => value)).toEqual([
      'https://github.com/microsoft/aspire/issues/1',
      'https://github.com/microsoft/aspire/issues/2',
      'https://github.com/microsoft/aspire/issues/3',
    ]);
  });

  it('recognizes contextual latest-release follow-ups without broad false positives', () => {
    const observations = '[Original poster]\nWhat Aspire version is current?';

    expect(isContextualLatestReleaseQuestion('Is that still the latest?', observations)).toBe(true);
    expect(isContextualLatestReleaseQuestion('Why does that fail?', observations)).toBe(false);
  });

  it('extracts unique HTTPS URLs and trims sentence punctuation', () => {
    expect(
      extractQuestionUrls(
        'See [issue](https://github.com/microsoft/aspire/issues/1), then https://aspire.dev/docs/. https://aspire.dev/docs/',
      ),
    ).toEqual(['https://github.com/microsoft/aspire/issues/1', 'https://aspire.dev/docs/']);
  });
});
