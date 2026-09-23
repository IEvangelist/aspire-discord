import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubActivityReader, type ActivityRequest } from '../../src/agent/github-activity.js';
import { CitationRegistry } from '../../src/citations.js';
import type { AppConfig } from '../../src/config.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

const repos = ['microsoft/aspire', 'microsoft/aspire.dev'] as const;
const config = createTestConfig({ githubMcp: { token: 'test-read-token' } }).githubMcp;
const request: ActivityRequest = {
  kind: 'issues',
  username: 'afscrome',
  since: '2026-09-01',
  until: '2026-09-30',
};

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), init);
}

function search(items: unknown[] = [], total = items.length, incomplete = false): Response {
  return json({ total_count: total, incomplete_results: incomplete, items });
}

function issue(
  number: number,
  repository = repos[0] as string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title: `Report ${String(number)}`,
    html_url: `https://github.com/${repository}/issues/${String(number)}`,
    repository_url: `https://api.github.com/repos/${repository}`,
    user: { login: 'afscrome' },
    state: 'open',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-23T13:00:00Z',
    body: 'An Aspire report.',
    ...overrides,
  };
}

function pull(
  number: number,
  repository = repos[0] as string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return issue(number, repository, {
    html_url: `https://github.com/${repository}/pull/${String(number)}`,
    pull_request: {},
    ...overrides,
  });
}

function comment(
  id: number,
  repository = repos[0] as string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    html_url: `https://github.com/${repository}/issues/1#issuecomment-${String(id)}`,
    user: { login: 'afscrome' },
    body: 'Comment text',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-23T00:00:00Z',
    ...overrides,
  };
}

function review(
  id: number,
  repository = repos[0] as string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    html_url: `https://github.com/${repository}/pull/90#pullrequestreview-${String(id)}`,
    user: { login: 'afscrome' },
    state: 'APPROVED',
    submitted_at: '2026-09-15T12:00:00Z',
    body: 'Reviewed successfully',
    ...overrides,
  };
}

function commit(repository = repos[0] as string, overrides: Record<string, unknown> = {}) {
  return {
    sha: 'a'.repeat(40),
    html_url: `https://github.com/${repository}/commit/${'a'.repeat(40)}`,
    author: { login: 'afscrome' },
    commit: {
      message: 'Commit message',
      author: { date: '2026-08-01T00:00:00Z', email: 'private@example.com' },
      committer: { date: '2026-09-03T00:00:00Z', email: 'private@example.com' },
    },
    ...overrides,
  };
}

function repositoryOf(url: URL): string {
  return (
    url.searchParams.get('q')?.match(/repo:(\S+)/u)?.[1] ??
    url.pathname.split('/').slice(2, 4).join('/')
  );
}

function fetchUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function mockedFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>((input, init) => {
    const url = fetchUrl(input);
    expect(url.origin).toBe('https://api.github.com');
    expect(repos).toContain(repositoryOf(url));
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-read-token');
    return Promise.resolve(handler(url, init));
  });
}

function emptyResponse(url: URL) {
  return url.pathname === '/search/issues' ? search() : json([]);
}

afterEach(() => vi.useRealTimers());

describe('GitHubActivityReader', () => {
  it('uses only the existing read token and returns unavailable, not zero, when disabled', async () => {
    const fetcher = mockedFetch(emptyResponse);
    const reader = new GitHubActivityReader(createTestConfig().githubMcp, testLogger, fetcher);
    expect(reader.enabled).toBe(false);
    const registry = new CitationRegistry();
    const result = await reader.read(request, registry);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.complete).toBe(false);
    expect(result.summary).toContain('matching count unknown');
    expect(result.notices).toHaveLength(2);
    expect(registry.all).toHaveLength(0);
  });

  it('requires the configured pair of Aspire repositories, even if runtime config is malformed', () => {
    for (const allowedRepositories of [['attacker/repo'], [repos[0]], [repos[0], repos[0]]]) {
      const invalid = { ...config, allowedRepositories } as unknown as AppConfig['githubMcp'];
      expect(() => new GitHubActivityReader(invalid, testLogger)).toThrow();
    }
  });

  it.each([
    { username: 'afscrome OR author:attacker' },
    { username: 'a--b' },
    { username: '@@afscrome' },
    { username: '-name' },
    { username: 'name-' },
    { username: 'x'.repeat(40) },
    { username: 'afscrome ' },
    { since: '2026-02-29' },
    { until: '2026-09-31' },
    { since: '2026-9-01' },
    { since: '2026-09-01T00:00:00Z' },
    { until: '2026-08-31' },
    { since: '2025-01-01', until: '2026-01-02' },
  ])('rejects invalid input without a network call: %j', async (overrides) => {
    const fetcher = mockedFetch(emptyResponse);
    const reader = new GitHubActivityReader(config, testLogger, fetcher);
    await expect(reader.read({ ...request, ...overrides }, new CitationRegistry())).rejects.toThrow(
      TypeError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts a real leap day, 366 inclusive days, and one leading @', async () => {
    const fetcher = mockedFetch(emptyResponse);
    const reader = new GitHubActivityReader(config, testLogger, fetcher);
    const result = await reader.read(
      {
        ...request,
        username: '@afscrome',
        since: '2024-02-29',
        until: '2025-02-28',
      },
      new CitationRegistry(),
    );
    expect(result.complete).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetchUrl(fetcher.mock.calls[0]![0]).toString()).toContain('author%3Aafscrome');
  });

  it('queries both repositories after an empty first repo, includes closed issues, and cites successful zeroes', async () => {
    const fetcher = mockedFetch((url) => {
      expect(url.searchParams.get('q')).toBe(
        `repo:${repositoryOf(url)} author:afscrome is:issue created:2026-09-01..2026-09-30`,
      );
      expect(url.searchParams.get('sort')).toBe('created');
      expect(url.searchParams.get('order')).toBe('asc');
      expect(url.searchParams.get('per_page')).toBe('100');
      return repositoryOf(url) === repos[0]
        ? search()
        : search([issue(4, repos[1], { state: 'closed', created_at: '2026-09-30T23:59:59Z' })]);
    });
    const reader = new GitHubActivityReader(config, testLogger, fetcher);
    expect(reader.enabled).toBe(true);
    const registry = new CitationRegistry();
    const result = await reader.read(request, registry);
    expect(result.complete).toBe(true);
    expect(result.itemCount).toBe(1);
    expect(result.summary).toContain('0 of 0 reported matches retrieved');
    expect(result.summary).toContain('1 of 1 reported matches retrieved');
    expect(result.summary).toContain('closed, created 2026-09-30');
    expect(result.context).toContain('"updatedAt":"2026-09-23T13:00:00Z"');
    expect(registry.all).toHaveLength(3);
    expect(registry.citedBy(result.summary, false)).toHaveLength(3);
  });

  it('reads PRs without mixing them into issues or implicitly restricting state', async () => {
    const fetcher = mockedFetch((url) => {
      expect(url.searchParams.get('q')).toContain('is:pr');
      expect(url.searchParams.get('q')).not.toMatch(/is:open|state:/u);
      return search([pull(1, repositoryOf(url), { state: 'closed' })]);
    });
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      { ...request, kind: 'pull-requests' },
      new CitationRegistry(),
    );
    expect(result.complete).toBe(true);
    expect(result.itemCount).toBe(2);
    expect(result.summary).toContain('pull-request #1');
  });

  it('paginates complete searches, distinguishes a display sample, and bounds context', async () => {
    const fetcher = mockedFetch((url) => {
      const start = (Number(url.searchParams.get('page')) - 1) * 100;
      return search(
        Array.from({ length: 100 }, (_, index) =>
          issue(start + index + 1, repositoryOf(url), { body: 'x'.repeat(600) }),
        ),
        200,
      );
    });
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.complete).toBe(true);
    expect(result.itemCount).toBe(400);
    expect(result.summary).toContain('Showing 10 of 400 retrieved records');
    expect(result.notices.join(' ')).toContain('remaining records omitted for length');
    expect(result.context.length).toBeLessThanOrEqual(18_000);
    expect(result.summary.split(/\s+/u).length).toBeLessThan(500);
  });

  it('caps searches at 300 per repository and never claims the cap was the total', async () => {
    const fetcher = mockedFetch((url) => {
      const start = (Number(url.searchParams.get('page')) - 1) * 100;
      return search(
        Array.from({ length: 100 }, (_, index) => issue(start + index + 1, repositoryOf(url))),
        301,
      );
    });
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(result.complete).toBe(false);
    expect(result.itemCount).toBe(600);
    expect(result.summary).toContain('300 of 301 reported matches retrieved');
    expect(result.notices.filter((notice) => notice.includes('search page cap'))).toHaveLength(2);
  });

  it('deduplicates stable URLs and flags inconsistent search totals', async () => {
    const fetcher = mockedFetch((url) =>
      search([issue(1, repositoryOf(url)), issue(1, repositoryOf(url))]),
    );
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(result.complete).toBe(false);
    expect(result.itemCount).toBe(2);
    expect(result.summary).toContain('1 of 2 reported matches retrieved');
    expect(result.notices.join(' ')).toContain('duplicate');
  });

  it('reports GitHub incomplete_results even on successful empty results', async () => {
    const fetcher = mockedFetch(() => search([], 0, true));
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(result.complete).toBe(false);
    expect(result.notices.join(' ')).toContain('GitHub marked the search incomplete');
  });

  it('preserves valid partial search rows when GitHub returns fewer than its reported total', async () => {
    const fetcher = mockedFetch((url) => search([issue(1, repositoryOf(url))], 200, true));
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(result.itemCount).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.summary).toContain('1 of 200 reported matches retrieved');
    expect(result.notices.join(' ')).toContain('search returned fewer results than reported');
  });

  it('keeps already retrieved evidence if a subsequent page fails', async () => {
    const fetcher = mockedFetch((url) =>
      url.searchParams.get('page') === '2'
        ? new Response('SECRET_PAGE_ERROR', { status: 500 })
        : search(
            Array.from({ length: 100 }, (_, index) => issue(index + 1, repositoryOf(url))),
            101,
          ),
    );
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(result.itemCount).toBe(200);
    expect(result.complete).toBe(false);
    expect(result.summary).toContain('100 of 101 reported matches retrieved');
    expect(result.context).not.toContain('SECRET_PAGE_ERROR');
  });

  it.each([401, 403, 404, 429, 500, 302])(
    'keeps querying the second repo after HTTP %i without echoing response secrets',
    async (status) => {
      const fetcher = mockedFetch((url) =>
        repositoryOf(url) === repos[0]
          ? new Response('test-read-token VERY_PRIVATE_RESPONSE', { status })
          : search([issue(8, repos[1])]),
      );
      const registry = new CitationRegistry();
      const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
        request,
        registry,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.complete).toBe(false);
      expect(result.itemCount).toBe(1);
      expect(result.summary).toContain('matching count unknown');
      expect(result.context).not.toContain('test-read-token');
      expect(result.context).not.toContain('VERY_PRIVATE_RESPONSE');
      expect(registry.all.every((citation) => citation.repo === repos[1])).toBe(true);
    },
  );

  it('labels rate limiting and sanitizes thrown network errors without logging their content', async () => {
    const log = vi.spyOn(testLogger, 'warn');
    const fetcher = mockedFetch((url) => {
      if (repositoryOf(url) === repos[0]) throw new Error('test-read-token PRIVATE_ERROR');
      return new Response('PRIVATE_BODY', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      });
    });
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(result.notices.join(' ')).toContain('network error');
    expect(result.notices.join(' ')).toContain('GitHub rate limit');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|test-read-token/u);
    expect(result.context).not.toMatch(/PRIVATE|test-read-token/u);
  });

  it.each([
    {},
    { total_count: 0, items: [] },
    { total_count: 3, incomplete_results: false, items: [] },
    { total_count: -1, incomplete_results: false, items: [] },
    {
      total_count: 1,
      incomplete_results: false,
      items: [issue(1, repos[0], { created_at: '2026-02-30T00:00:00Z' })],
    },
    {
      total_count: 1,
      incomplete_results: false,
      items: [issue(1, repos[0], { user: { login: 'another-person' } })],
    },
    { total_count: 1, incomplete_results: false, items: [pull(1)] },
  ])('does not represent malformed search payloads as zero: %j', async (payload) => {
    const fetcher = mockedFetch(() => json(payload));
    const registry = new CitationRegistry();
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      registry,
    );
    expect(result.complete).toBe(false);
    expect(result.summary).toContain('matching count unknown');
    expect(result.summary).not.toContain('0 of 0');
    expect(registry.all).toHaveLength(0);
  });

  it.each([
    'https://github.com/other/repo/issues/1',
    'https://github.com/microsoft/aspire.dev/issues/1',
    'http://github.com/microsoft/aspire/issues/1',
    'https://github.com.evil.test/microsoft/aspire/issues/1',
    'https://user:password@github.com/microsoft/aspire/issues/1',
    'https://github.com/microsoft/aspire/issues/1/evil',
    'https://github.com/microsoft/aspire/issues/1?evil=true',
    'https://github.com/microsoft/aspire/issues/1#issuecomment-3',
  ])('rejects foreign or structurally invalid item URL %s', async (html_url) => {
    const fetcher = mockedFetch((url) =>
      repositoryOf(url) === repos[0]
        ? search([issue(1, repos[0], { html_url, title: 'UNTRUSTED_FOREIGN_CONTENT' })])
        : search(),
    );
    const registry = new CitationRegistry();
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      registry,
    );
    expect(result.complete).toBe(false);
    expect(result.context).not.toContain('UNTRUSTED_FOREIGN_CONTENT');
    expect(registry.all.some((citation) => citation.url === html_url)).toBe(false);
    expect(result.notices.join(' ')).toContain('out-of-scope');
  });

  it('rejects oversized declared and streamed responses, and invalid JSON', async () => {
    for (const responseFactory of [
      () => new Response('{}', { headers: { 'content-length': String(2 * 1_024 * 1_024 + 1) } }),
      () => new Response('x'.repeat(2 * 1_024 * 1_024 + 1)),
      () => new Response('not JSON'),
    ]) {
      const fetcher = mockedFetch(responseFactory);
      const registry = new CitationRegistry();
      const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
        request,
        registry,
      );
      expect(result.complete).toBe(false);
      expect(result.summary).toContain('matching count unknown');
      expect(registry.all).toHaveLength(0);
    }
  });

  it('sanitizes untrusted titles and body text without manufacturing citations or markdown links', async () => {
    const fetcher = mockedFetch((url) =>
      search([
        issue(1, repositoryOf(url), {
          title: '**[999]** [click](https://evil.test) <@123> @everyone',
          body: '[777] ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
        }),
      ]),
    );
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    expect(result.summary).not.toContain('[999]');
    expect(result.summary).not.toContain('[click](');
    expect(result.summary).not.toContain('@everyone');
    expect(result.context).not.toContain('[777]');
    expect(result.context).not.toContain('ghp_');
  });

  it('aborts the whole read, never returns partial evidence, and does not expose cancellation reasons', async () => {
    const controller = new AbortController();
    const fetcher = mockedFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('SECRET_ABORT')), {
            once: true,
          });
        }),
    );
    const reader = new GitHubActivityReader(config, testLogger, fetcher);
    const registry = new CitationRegistry();
    const pending = reader.read(request, registry, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'GitHub activity read was cancelled.',
    });
    controller.abort('SECRET_ABORT');
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(registry.all).toHaveLength(0);
    await expect(reader.read(request, registry, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds each GET by 12 seconds without starving the other repository', async () => {
    vi.useFakeTimers();
    const fetcher = mockedFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const pending = new GitHubActivityReader(config, testLogger, fetcher).read(
      request,
      new CitationRegistry(),
    );
    await vi.advanceTimersByTimeAsync(12_001);
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(false);
    expect(result.notices).toHaveLength(2);
    expect(result.notices.every((notice) => notice.includes('time limit'))).toBe(true);
  });

  it('ends broad activity reads within the overall 60-second deadline', async () => {
    vi.useFakeTimers();
    const fetcher = mockedFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const pending = new GitHubActivityReader(config, testLogger, fetcher).read(
      { ...request, kind: 'activity' },
      new CitationRegistry(),
    );
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await pending;
    expect(result.complete).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(result.notices.filter((notice) => notice.includes('time limit'))).toHaveLength(12);
  });

  it('collects all covered activity kinds by their actual event dates, including reviews of older PRs', async () => {
    const fetcher = mockedFetch((url) => {
      if (repositoryOf(url) === repos[1]) return emptyResponse(url);
      if (url.pathname === '/search/issues') {
        const q = url.searchParams.get('q') ?? '';
        if (q.includes('reviewed-by:')) {
          expect(q).toContain('updated:>=2026-09-01');
          expect(q).not.toMatch(/created:|2026-09-30/u);
          return search([
            pull(90, repos[0], {
              user: { login: 'someone-else' },
              created_at: '2020-01-01T00:00:00Z',
              updated_at: '2026-10-15T00:00:00Z',
            }),
          ]);
        }
        return q.includes('is:issue') ? search([issue(1)]) : search([pull(2)]);
      }
      if (url.pathname.endsWith('/issues/comments')) {
        expect(url.searchParams.get('since')).toBe('2026-09-01T00:00:00Z');
        expect(url.searchParams.get('sort')).toBe('created');
        expect(url.searchParams.get('direction')).toBe('asc');
        return json([
          comment(1),
          comment(2, repos[0], { created_at: '2026-08-31T23:59:59Z' }),
          comment(3, repos[0], { user: { login: 'someone-else' } }),
          comment(4, repos[0], { created_at: '2026-09-30T23:59:59.999Z' }),
          comment(5, repos[0], { created_at: '2026-10-01T00:00:00Z' }),
        ]);
      }
      if (url.pathname.endsWith('/pulls/comments'))
        return json([
          comment(6, repos[0], {
            html_url: 'https://github.com/microsoft/aspire/pull/2#discussion_r6',
          }),
        ]);
      if (url.pathname.endsWith('/commits')) {
        expect(url.searchParams.get('author')).toBe('afscrome');
        expect(url.searchParams.get('until')).toBe('2026-09-30T23:59:59Z');
        expect(url.searchParams.has('sha')).toBe(false);
        return json([commit()]);
      }
      if (url.pathname.endsWith('/reviews'))
        return json([
          review(1),
          review(2, repos[0], { submitted_at: '2026-10-01T00:00:00Z' }),
          review(3, repos[0], { user: { login: 'someone-else' } }),
          review(4, repos[0], { state: 'PENDING', submitted_at: null }),
          review(5, repos[0], { state: 'PENDING', submitted_at: undefined }),
        ]);
      throw new Error('Unexpected endpoint');
    });
    const registry = new CitationRegistry();
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      { ...request, kind: 'activity' },
      registry,
    );
    expect(result.itemCount).toBe(7);
    expect(result.complete).toBe(false);
    expect(result.summary).toContain('default-branch commits');
    expect(result.summary).toContain('not a complete GitHub activity history');
    expect(result.summary).toContain('APPROVED');
    expect(result.context).not.toContain('private@example.com');
    const urls = registry.all.map((citation) => citation.url);
    expect(urls).toContain('https://github.com/microsoft/aspire/issues/1#issuecomment-1');
    expect(urls).toContain('https://github.com/microsoft/aspire/issues/1#issuecomment-4');
    expect(urls).not.toContain('https://github.com/microsoft/aspire/issues/1#issuecomment-2');
    expect(urls).toContain('https://github.com/microsoft/aspire/pull/90#pullrequestreview-1');
    expect(urls).not.toContain('https://github.com/microsoft/aspire/pull/90#pullrequestreview-2');
    expect(fetcher).toHaveBeenCalledTimes(13);
  });

  it('bounds every activity category and review candidates fairly to fewer than 40 GETs', async () => {
    const fetcher = mockedFetch((url) => {
      const repository = repositoryOf(url);
      const start = (Number(url.searchParams.get('page')) - 1) * 100;
      if (url.pathname === '/search/issues') {
        const q = url.searchParams.get('q') ?? '';
        if (q.includes('reviewed-by:'))
          return search(Array.from({ length: 5 }, (_, index) => pull(index + 1, repository)));
        return search(
          Array.from({ length: 100 }, (_, index) =>
            q.includes('is:issue')
              ? issue(start + index + 1, repository)
              : pull(start + index + 1, repository),
          ),
          250,
        );
      }
      if (url.pathname.endsWith('/reviews')) {
        const number = url.pathname.split('/').at(-2);
        return json(
          Array.from({ length: 100 }, (_, index) =>
            review(start + index + 1, repository, {
              html_url: `https://github.com/${repository}/pull/${number ?? ''}#pullrequestreview-${String(start + index + 1)}`,
            }),
          ),
        );
      }
      if (url.pathname.endsWith('/commits'))
        return json(Array.from({ length: 100 }, () => commit(repository)));
      return json(
        Array.from({ length: 100 }, (_, index) => {
          const id = start + index + 1;
          return comment(
            id,
            repository,
            url.pathname.endsWith('/pulls/comments')
              ? {
                  html_url: `https://github.com/${repository}/pull/1#discussion_r${String(id)}`,
                }
              : {},
          );
        }),
      );
    });
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      { ...request, kind: 'activity' },
      new CitationRegistry(),
    );
    expect(fetcher).toHaveBeenCalledTimes(38);
    for (const repository of repos) {
      expect(
        fetcher.mock.calls.filter(([input]) => repositoryOf(fetchUrl(input)) === repository),
      ).toHaveLength(19);
    }
    expect(result.complete).toBe(false);
    expect(result.notices.join(' ')).toContain('review candidate cap (4 PRs)');
    expect(result.notices.join(' ')).toContain('list page cap (200 records per endpoint)');
    expect(result.context.length).toBeLessThanOrEqual(18_000);
    expect(result.summary.split(/\s+/u).length).toBeLessThan(500);
  });

  it('reports failed review fetching as incomplete rather than asserting there were no reviews', async () => {
    const fetcher = mockedFetch((url) => {
      if (url.searchParams.get('q')?.includes('reviewed-by:'))
        return search([pull(90, repositoryOf(url))]);
      if (url.pathname.endsWith('/reviews')) return new Response('private', { status: 503 });
      return emptyResponse(url);
    });
    const result = await new GitHubActivityReader(config, testLogger, fetcher).read(
      { ...request, kind: 'activity' },
      new CitationRegistry(),
    );
    expect(result.complete).toBe(false);
    expect(result.summary).toContain(
      'PR reviews: unavailable; matching count unknown (partial: GitHub service error)',
    );
    expect(result.notices.filter((notice) => notice.includes('PR reviews'))).toHaveLength(3);
  });
});
