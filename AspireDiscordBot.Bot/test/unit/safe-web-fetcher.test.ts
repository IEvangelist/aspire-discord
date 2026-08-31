import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeWebFetcher } from '../../src/agent/safe-web-fetcher.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SafeWebFetcher', () => {
  it('fetches bounded text from an exact allowlisted HTTPS host', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '<html><head><title>Aspire guidance</title><script>secret()</script></head><body><nav>Navigation noise</nav><main data-pagefind-body><h1>Redis</h1><p>Use AddRedis.</p></main></body></html>',
          {
            headers: { 'content-type': 'text/html; charset=utf-8' },
            status: 200,
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new SafeWebFetcher(createTestConfig().linkContext, testLogger);

    const result = await fetcher.fetch('https://aspire.dev/caching/redis/?tracking=value');

    expect(result.title).toBe('Aspire guidance');
    expect(result.content).toContain('Use AddRedis.');
    expect(result.content).not.toContain('secret()');
    expect(result.content).not.toContain('Navigation noise');
    expect(result.citationUrl).toBe('https://aspire.dev/caching/redis/');
  });

  it.each([
    'http://aspire.dev/docs',
    'https://evil.aspire.dev/docs',
    'https://127.0.0.1/docs',
    'https://user:password@aspire.dev/docs',
  ])('rejects unsafe or non-allowlisted targets: %s', (url) => {
    const fetcher = new SafeWebFetcher(createTestConfig().linkContext, testLogger);
    expect(fetcher.canFetch(url)).toBe(false);
  });

  it('validates every redirect target before following it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          headers: { location: 'https://example.com/private' },
          status: 302,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new SafeWebFetcher(createTestConfig().linkContext, testLogger);

    await expect(fetcher.fetch('https://aspire.dev/start')).rejects.toThrow(/not allowed/u);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('follows validated HTML meta refresh redirects', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          '<meta http-equiv="refresh" content="0;url=/current"><title>Redirecting</title>',
          { headers: { 'content-type': 'text/html' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('<title>Current</title><p>Fresh guidance.</p>', {
          headers: { 'content-type': 'text/html' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new SafeWebFetcher(createTestConfig().linkContext, testLogger);

    const result = await fetcher.fetch('https://aspire.dev/old');

    expect(result.title).toBe('Current');
    expect(result.citationUrl).toBe('https://aspire.dev/current');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects declared bodies above the size limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('small', {
            headers: {
              'content-length': '2000000',
              'content-type': 'text/plain',
            },
          }),
      ),
    );
    const fetcher = new SafeWebFetcher(createTestConfig().linkContext, testLogger);

    await expect(fetcher.fetch('https://aspire.dev/large')).rejects.toThrow(/size limit/u);
  });
});
