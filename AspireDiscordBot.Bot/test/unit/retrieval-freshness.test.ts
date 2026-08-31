import { describe, expect, it } from 'vitest';
import type { VectorSearchResult } from '../../src/domain.js';
import {
  isLatestAspireReleaseQuestion,
  isVersionedWhatsNewPath,
  prioritizeCurrentDocumentation,
} from '../../src/agent/retrieval-freshness.js';

const evergreen: VectorSearchResult = {
  content: 'Current Redis guidance.',
  path: 'src/frontend/src/content/docs/caching/redis.mdx',
  repo: 'microsoft/aspire.dev',
  score: 0.8,
  title: 'Redis',
  url: 'https://aspire.dev/caching/redis/',
};
const aspire9: VectorSearchResult = {
  ...evergreen,
  path: 'src/frontend/src/content/docs/whats-new/aspire-9.mdx',
  score: 0.99,
  title: "What's new in Aspire 9",
  url: 'https://aspire.dev/whats-new/aspire-9/',
};
const aspire135: VectorSearchResult = {
  ...evergreen,
  path: 'src/frontend/src/content/docs/whats-new/aspire-13-5.mdx',
  score: 0.95,
  title: "What's new in Aspire 13.5",
  url: 'https://aspire.dev/whats-new/aspire-13-5/',
};

describe('documentation freshness policy', () => {
  it('removes all versioned release notes from ordinary and latest queries', () => {
    expect(
      prioritizeCurrentDocumentation([aspire9, aspire135, evergreen], 'How do I add Redis?', 6),
    ).toEqual([evergreen]);
    expect(
      prioritizeCurrentDocumentation(
        [aspire9, aspire135, evergreen],
        'What is the latest version of Aspire?',
        6,
      ),
    ).toEqual([evergreen]);
  });

  it('allows only explicitly requested historical release notes', () => {
    expect(
      prioritizeCurrentDocumentation(
        [aspire135, aspire9, evergreen],
        'What changed in Aspire 9?',
        6,
      ),
    ).toEqual([aspire9, evergreen]);
  });

  it('recognizes release currency questions and versioned paths', () => {
    expect(isLatestAspireReleaseQuestion('What is the current Aspire version?')).toBe(true);
    expect(isLatestAspireReleaseQuestion("What's new in Aspire?")).toBe(true);
    expect(isLatestAspireReleaseQuestion("What's new in Aspire 9?")).toBe(false);
    expect(isLatestAspireReleaseQuestion('Is Aspire 13.5.3 the latest release?')).toBe(true);
    expect(isLatestAspireReleaseQuestion('What changed in Aspire 9?')).toBe(false);
    expect(isVersionedWhatsNewPath('whats-new/aspire-13-5.mdx')).toBe(true);
    expect(isVersionedWhatsNewPath('whats-new/upgrade-aspire.mdx')).toBe(false);
  });
});
