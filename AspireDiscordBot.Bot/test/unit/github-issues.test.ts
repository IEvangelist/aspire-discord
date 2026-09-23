import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppIssuePublisher, type GitHubAppSigner } from '../../src/issues/github-app.js';
import { IssuePublishError, type IssueRepository } from '../../src/issues/types.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const repository = 'dotnet/aspire';
const marker = '<!-- aspire-discord:opaque-123 -->';
const since = '2026-09-15T12:00:00Z';

afterEach(() => {
  vi.useRealTimers();
});

function json(data: unknown, status = 200, requestId = 'AB12:CD34:EF56'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'x-github-request-id': requestId },
  });
}

function metadata(fullName = repository, extra: Record<string, unknown> = {}): Response {
  return json({
    full_name: fullName,
    visibility: 'public',
    has_issues: true,
    archived: false,
    ...extra,
  });
}

function token(value = 'ghs_repo_token', extra: Record<string, unknown> = {}): Response {
  return json(
    {
      token: value,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      permissions: { issues: 'write', metadata: 'read' },
      ...extra,
    },
    201,
  );
}

function issue(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    html_url: `https://github.com/${repository}/issues/${number}`,
    title: `Issue ${number}`,
    body: 'Existing description',
    ...extra,
  };
}

function fakeSigner(): GitHubAppSigner {
  return { sign: async (data) => sign('RSA-SHA256', data, privateKey) };
}

function harness(
  installationId?: number,
  signer: GitHubAppSigner = fakeSigner(),
): {
  client: GitHubAppIssuePublisher;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
} {
  const fetchMock = vi.fn<typeof fetch>();
  const client = new GitHubAppIssuePublisher(
    {
      appId: '4968096',
      signer,
      ...(installationId === undefined ? {} : { installationId }),
    },
    fetchMock,
  );
  return { client, fetchMock };
}

function prepareAccess(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): void {
  fetchMock
    .mockResolvedValueOnce(json({ id: 123 }))
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(metadata());
}

function issuePosts(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): unknown[] {
  return fetchMock.mock.calls.filter(
    ([url, options]) =>
      requestUrl(url).href === `https://api.github.com/repos/${repository}/issues` &&
      options?.method === 'POST',
  );
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

describe('GitHubAppIssuePublisher authentication and repository inspection', () => {
  it('signs RS256 JWT claims, discovers installation, and requests only repository issue access', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const fetchMock = vi.fn<typeof fetch>();
    const signer = fakeSigner();
    const signMock = vi.spyOn(signer, 'sign');
    const client = new GitHubAppIssuePublisher({ appId: '4968096', signer }, fetchMock);
    prepareAccess(fetchMock);

    await expect(client.inspect('DotNet/Aspire')).resolves.toEqual({
      fullName: repository,
      visibility: 'public',
      issuesEnabled: true,
    });

    const [discoveryUrl, discovery] = fetchMock.mock.calls[0]!;
    expect(discoveryUrl).toBe(`https://api.github.com/repos/${repository}/installation`);
    const jwt = new Headers(discovery?.headers).get('authorization')!.slice('Bearer '.length);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const now = Math.floor(Date.now() / 1000);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iat: now - 60,
      exp: now + 540,
      iss: '4968096',
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header!}.${claims!}`),
        publicKey,
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
    expect(signMock).toHaveBeenCalledOnce();
    expect(Buffer.from(signMock.mock.calls[0]![0]).toString()).toBe(`${header!}.${claims!}`);
    expect(signMock.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);

    const [mintUrl, mint] = fetchMock.mock.calls[1]!;
    expect(mintUrl).toBe('https://api.github.com/app/installations/123/access_tokens');
    expect(mint?.method).toBe('POST');
    expect(new Headers(mint?.headers).get('authorization')).toBe(`Bearer ${jwt}`);
    expect(JSON.parse(mint?.body as string)).toEqual({
      repositories: ['aspire'],
      permissions: { issues: 'write' },
    });
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get('authorization')).toBe(
      'Bearer ghs_repo_token',
    );
    for (const [url, options] of fetchMock.mock.calls) {
      expect(requestUrl(url).origin).toBe('https://api.github.com');
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('verifies a configured installation against the repository with its scoped token', async () => {
    const { client, fetchMock } = harness(456);
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(metadata());
    await client.inspect(repository);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.github.com/app/installations/456/access_tokens',
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(`https://api.github.com/repos/${repository}`);
  });

  it('accepts optional grant details only when compatible with the requested scope', async () => {
    const { client, fetchMock } = harness(123);
    fetchMock
      .mockResolvedValueOnce(
        json(
          {
            token: 'scoped-token',
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            repositories: [{ full_name: 'DotNet/Aspire' }],
          },
          201,
        ),
      )
      .mockResolvedValueOnce(metadata());
    await expect(client.inspect(repository)).resolves.toMatchObject({ issuesEnabled: true });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({
      repositories: ['aspire'],
      permissions: { issues: 'write' },
    });
  });

  it.each([
    'https://github.com/dotnet/aspire',
    'dotnet/../aspire',
    'dotnet/..',
    'dotnet/.',
    'dotnet/aspire?x=1',
    'dotnet/aspire#fragment',
    'dotnet\\aspire',
    'dotnet/%2e%2e',
    'dotnet/aspire/extra',
    'dotnet/aspire\n',
  ])('rejects unsafe repository input before any request: %s', async (value) => {
    const { client, fetchMock } = harness();
    await expect(client.create(value, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { full_name: 'another/aspire' },
    { visibility: 'internal' },
    { archived: undefined },
    { has_issues: undefined },
  ])('rejects mismatched or malformed metadata: %j', async (extra) => {
    const { client, fetchMock } = harness(123);
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(metadata(repository, extra));
    await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
      status: 200,
      requestId: 'AB12:CD34:EF56',
    });
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it.each([{ archived: true }, { has_issues: false }])(
    'reports disabled issues and does not publish: %j',
    async (extra) => {
      const { client, fetchMock } = harness(123);
      fetchMock
        .mockResolvedValueOnce(token())
        .mockResolvedValueOnce(metadata(repository, extra))
        .mockResolvedValueOnce(metadata(repository, extra));
      await expect(client.inspect(repository)).resolves.toMatchObject({ issuesEnabled: false });
      await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
        outcomeUnknown: false,
      });
      expect(issuePosts(fetchMock)).toHaveLength(0);
    },
  );

  it('reports private repository visibility', async () => {
    const { client, fetchMock } = harness(123);
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(metadata(repository, { visibility: 'private' }));
    await expect(client.inspect(repository)).resolves.toMatchObject({ visibility: 'private' });
  });

  it.each([
    { permissions: { issues: 'read' } },
    { permissions: { metadata: 'read' } },
    { permissions: null },
    { repositories: [{ full_name: 'other/aspire' }] },
    { repositories: [{ full_name: repository }, { full_name: 'dotnet/runtime' }] },
    { expires_at: 'invalid' },
    { expires_at: '2020-01-01T00:00:00Z' },
  ])('rejects insufficient or invalid installation grants: %j', async (extra) => {
    const { client, fetchMock } = harness(123);
    fetchMock.mockResolvedValueOnce(token('secret-token', extra));
    await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
      status: 201,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('reuses an unexpired token only for its repository and remints expired tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const { client, fetchMock } = harness(123);
    fetchMock
      .mockResolvedValueOnce(token('first-repo'))
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(token('second-repo'))
      .mockResolvedValueOnce(metadata('other/aspire'));
    await client.inspect(repository);
    await client.inspect(repository);
    await client.inspect('other/aspire');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get('authorization')).toBe(
      'Bearer first-repo',
    );
    expect(new Headers(fetchMock.mock.calls[4]![1]?.headers).get('authorization')).toBe(
      'Bearer second-repo',
    );

    vi.setSystemTime(new Date('2026-09-15T13:00:01Z'));
    fetchMock.mockResolvedValueOnce(token('renewed-token')).mockResolvedValueOnce(metadata());
    await client.inspect(repository);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(new Headers(fetchMock.mock.calls[6]![1]?.headers).get('authorization')).toBe(
      'Bearer renewed-token',
    );
  });

  it('evicts the least recently used token beyond twenty repositories', async () => {
    const { client, fetchMock } = harness(123);
    for (let index = 0; index < 21; index += 1) {
      fetchMock
        .mockResolvedValueOnce(token(`token-${index}`))
        .mockResolvedValueOnce(metadata(`owner/repo-${index}`));
      await client.inspect(`owner/repo-${index}`);
    }
    fetchMock
      .mockResolvedValueOnce(token('replacement'))
      .mockResolvedValueOnce(metadata('owner/repo-0'));
    await client.inspect('owner/repo-0');
    expect(fetchMock).toHaveBeenCalledTimes(44);
    expect(fetchMock.mock.calls[42]![1]?.method).toBe('POST');
  });

  it('does not follow repository redirects or publish after a failed preflight', async () => {
    const { client, fetchMock } = harness(123);
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: 'https://evil.example/steal' },
      }),
    );
    await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
      status: 301,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]?.redirect).toBe('error');
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('sanitizes signer failures before any HTTP request or issue POST', async () => {
    const signer = {
      sign: vi.fn<GitHubAppSigner['sign']>().mockRejectedValue(
        Object.assign(new Error('PRIVATE_SDK_REQUEST_AND_JWT'), {
          request: { body: 'PRIVATE_SIGNING_INPUT' },
        }),
      ),
    };
    const { client, fetchMock } = harness(undefined, signer);
    await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App authentication failed.',
    });
    expect(signer.sign).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, 1, 32, 255, 1025])(
    'rejects an invalid %i-byte signature before HTTP',
    async (size) => {
      const { client, fetchMock } = harness(undefined, {
        sign: async () => new Uint8Array(size),
      });
      await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
        outcomeUnknown: false,
        message: 'GitHub App authentication failed.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('cancels asynchronous signing promptly even if the signer ignores cancellation', async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<Uint8Array>();
    const signer = { sign: vi.fn<GitHubAppSigner['sign']>().mockReturnValue(pending.promise) };
    const { client, fetchMock } = harness(undefined, signer);
    const creation = client.create(repository, 'Title', 'Body', controller.signal);
    const assertion = expect(creation).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App authentication failed.',
    });
    controller.abort(new Error('PRIVATE_CANCELLATION_REASON'));
    await assertion;
    expect(signer.sign.mock.calls[0]![1]?.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    pending.resolve(new Uint8Array(256));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds asynchronous signing without retrying or making HTTP requests', async () => {
    vi.useFakeTimers();
    const signer = {
      sign: vi
        .fn<GitHubAppSigner['sign']>()
        .mockImplementation(() => new Promise<Uint8Array>(() => undefined)),
    };
    const { client, fetchMock } = harness(undefined, signer);
    const assertion = expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App authentication failed.',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(signer.sign).toHaveBeenCalledOnce();
    expect(signer.sign.mock.calls[0]![1]?.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never invokes the signer for an already aborted caller', async () => {
    const signer = { sign: vi.fn<GitHubAppSigner['sign']>() };
    const { client, fetchMock } = harness(undefined, signer);
    await expect(
      client.create(repository, 'Title', 'Body', AbortSignal.abort()),
    ).rejects.toMatchObject({ outcomeUnknown: false });
    expect(signer.sign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GitHubAppIssuePublisher duplicate search', () => {
  it('uses a bounded fixed repository query, filters unsafe results, and returns at most five', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          issue(1, { html_url: 'https://github.com/other/aspire/issues/1' }),
          issue(2, { html_url: 'https://evil.example/dotnet/aspire/issues/2' }),
          issue(3, { pull_request: {} }),
          issue(4, { html_url: 'https://github.com/dotnet/aspire/issues/4?redirect=evil' }),
          issue(5, { html_url: 'https://github.com/dotnet/aspire/issues/55' }),
          issue(6, { html_url: 'https://user@github.com/dotnet/aspire/issues/6' }),
          issue(7, { html_url: 'http://github.com/dotnet/aspire/issues/7' }),
          ...Array.from({ length: 8 }, (_, index) => issue(index + 10)),
        ],
      }),
    );
    const results = await client.findDuplicates(
      repository,
      'Redis failure" OR repo:evil/private is:pr NOT secret '.repeat(20),
    );
    expect(results.map((result) => result.number)).toEqual([10, 11, 12, 13, 14]);
    const url = requestUrl(fetchMock.mock.calls[3]![0]);
    expect(url.pathname).toBe('/search/issues');
    const query = url.searchParams.get('q')!;
    expect(query).toMatch(/^repo:dotnet\/aspire is:issue in:title /u);
    expect(query).not.toContain('repo:evil');
    expect(query).not.toContain('is:pr');
    expect(query).not.toContain(' OR ');
    expect(query.length).toBeLessThanOrEqual(256);
    expect(url.searchParams.get('per_page')).toBe('20');
  });

  it('returns no duplicates without a useful title keyword', async () => {
    const { client, fetchMock } = harness();
    await expect(client.findDuplicates(repository, '!!!')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GitHubAppIssuePublisher single-attempt publication', () => {
  it.each(['token', 'metadata'])(
    'checks live authorization after a pending %s request and stops a revoked publication',
    async (pendingRequest) => {
      const { client, fetchMock } = harness(123);
      const pending = Promise.withResolvers<Response>();
      const entered = Promise.withResolvers<boolean>();
      const awaitPending = (): Promise<Response> => {
        entered.resolve(true);
        return pending.promise;
      };
      if (pendingRequest === 'token') {
        fetchMock.mockImplementationOnce(awaitPending).mockResolvedValueOnce(metadata());
      } else {
        fetchMock.mockResolvedValueOnce(token()).mockImplementationOnce(awaitPending);
      }
      let revoked = false;
      const authorize = vi.fn<(current: IssueRepository) => void>(() => {
        if (revoked) {
          throw new Error('PRIVATE_POLICY_REVOCATION_REASON');
        }
      });

      const creation = client.create(repository, 'Title', 'Body', undefined, authorize);
      await entered.promise;
      revoked = true;
      pending.resolve(pendingRequest === 'token' ? token() : metadata());

      await expect(creation).rejects.toMatchObject({
        outcomeUnknown: false,
        message: 'GitHub issue publication authorization failed.',
      });
      expect(authorize).toHaveBeenCalledExactlyOnceWith({
        fullName: repository,
        visibility: 'public',
        issuesEnabled: true,
      });
      expect(issuePosts(fetchMock)).toHaveLength(0);
    },
  );

  it('uses fresh visibility rather than the preview metadata in the final authorization check', async () => {
    const { client, fetchMock } = harness(123);
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(metadata(repository, { visibility: 'private' }));
    const preview = await client.inspect(repository);
    const pending = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<boolean>();
    fetchMock.mockImplementationOnce(() => {
      entered.resolve(true);
      return pending.promise;
    });
    const authorize = vi.fn((current: IssueRepository) => {
      if (current.visibility !== preview.visibility) {
        throw new Error('PRIVATE_REPOSITORY_VISIBILITY_CHANGED');
      }
    });
    const creation = client.create(repository, 'Title', 'Body', undefined, authorize);
    await entered.promise;
    pending.resolve(metadata(repository, { visibility: 'public' }));

    await expect(creation).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub issue publication authorization failed.',
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      fullName: repository,
      visibility: 'public',
      issuesEnabled: true,
    });
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('does not yield between final authorization and sending the issue POST', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    const order: string[] = [];
    fetchMock.mockImplementationOnce(() => {
      order.push('post');
      return Promise.resolve(json(issue(42), 201));
    });
    const authorize = vi.fn((current: IssueRepository) => {
      expect(current).toEqual({
        fullName: repository,
        visibility: 'public',
        issuesEnabled: true,
      });
      order.push('authorize');
      queueMicrotask(() => {
        order.push('microtask');
      });
    });

    await expect(
      client.create(repository, 'Title', 'Body', undefined, authorize),
    ).resolves.toMatchObject({ number: 42 });
    expect(order).toEqual(['authorize', 'post', 'microtask']);
    expect(issuePosts(fetchMock)).toHaveLength(1);
  });

  it.each([
    new TypeError('PRIVATE_UNEXPECTED_CALLBACK_ERROR'),
    new IssuePublishError('PRIVATE_CALLBACK_ERROR', true, 500, 'UNTRUSTED:123'),
  ])('propagates unexpected authorization failures safely without publishing', async (failure) => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    const authorize = (): void => {
      throw failure;
    };

    await expect(client.create(repository, 'Title', 'Body', undefined, authorize)).rejects.toEqual(
      new IssuePublishError('GitHub issue publication authorization failed.', false),
    );
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('normalizes GitHub case-preserving issue URLs to the canonical lowercase repository', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(
      json(issue(42, { html_url: 'https://github.com/DotNet/Aspire/issues/42' }), 201),
    );
    await expect(client.create('DotNet/Aspire', 'Title', 'Body')).resolves.toEqual({
      number: 42,
      url: `https://github.com/${repository}/issues/42`,
    });
  });

  it('creates once with exactly the supplied title and body', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(json(issue(42), 201));
    await expect(
      client.create(repository, 'Proposed issue', `Description\n${marker}`),
    ).resolves.toEqual({
      number: 42,
      url: `https://github.com/${repository}/issues/42`,
    });
    expect(issuePosts(fetchMock)).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[3]![1]?.body as string)).toEqual({
      title: 'Proposed issue',
      body: `Description\n${marker}`,
    });
  });

  it.each([
    [200, true],
    [202, true],
    [302, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ])('classifies HTTP %i without retries (unknown: %s)', async (status, outcomeUnknown) => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(json({ message: 'PRIVATE_RESPONSE_BODY' }, status));
    const error: unknown = await client
      .create(repository, 'PRIVATE_TITLE', 'PRIVATE_BODY')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssuePublishError);
    expect(error).toMatchObject({ outcomeUnknown, status, requestId: 'AB12:CD34:EF56' });
    expect(String(error)).not.toMatch(/PRIVATE|ghs_repo_token/u);
    expect(issuePosts(fetchMock)).toHaveLength(1);
  });

  it('classifies transport failure as unknown and does not expose the underlying error', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockRejectedValueOnce(new Error('PRIVATE_TOKEN and PRIVATE_BODY'));
    const error: unknown = await client
      .create(repository, 'Title', 'Body')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcomeUnknown: true });
    expect(String(error)).not.toContain('PRIVATE');
    expect(issuePosts(fetchMock)).toHaveLength(1);
  });

  it('times out a single creation attempt and reports unknown', async () => {
    vi.useFakeTimers();
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const creation = client.create(repository, 'Title', 'Body');
    const assertion = expect(creation).rejects.toMatchObject({ outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(issuePosts(fetchMock)).toHaveLength(1);
    expect(fetchMock.mock.calls[3]![1]?.signal?.aborted).toBe(true);
  });

  it('honors caller cancellation during creation without resending', async () => {
    const { client, fetchMock } = harness();
    const controller = new AbortController();
    prepareAccess(fetchMock);
    fetchMock.mockImplementationOnce((_url, options) => {
      expect(options?.signal?.aborted).toBe(false);
      controller.abort(new Error('PRIVATE_CALLER_REASON'));
      return new Promise<Response>(() => undefined);
    });
    await expect(
      client.create(repository, 'Title', 'Body', controller.signal),
    ).rejects.toMatchObject({
      outcomeUnknown: true,
      message: 'GitHub request failed.',
    });
    expect(issuePosts(fetchMock)).toHaveLength(1);
  });

  it('does not send any request for an already cancelled caller', async () => {
    const { client, fetchMock } = harness();
    await expect(
      client.create(repository, 'Title', 'Body', AbortSignal.abort()),
    ).rejects.toMatchObject({ outcomeUnknown: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies a mint failure before issue POST as definitely not created', async () => {
    const { client, fetchMock } = harness(123);
    fetchMock.mockRejectedValueOnce(new Error('Connection failed'));
    await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('classifies a timed out mint as not created and does not retry', async () => {
    vi.useFakeTimers();
    const { client, fetchMock } = harness(123);
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const creation = client.create(repository, 'Title', 'Body');
    const assertion = expect(creation).rejects.toMatchObject({ outcomeUnknown: false });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('does not send an issue POST if cancellation happens after repository verification', async () => {
    const { client, fetchMock } = harness(123);
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(token()).mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(metadata());
    });
    await expect(
      client.create(repository, 'Title', 'Body', controller.signal),
    ).rejects.toMatchObject({
      outcomeUnknown: false,
    });
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it.each([
    'not json PRIVATE_BODY',
    JSON.stringify({ number: 42 }),
    JSON.stringify(issue(42, { html_url: 'https://github.com/other/repo/issues/42' })),
    JSON.stringify(issue(42, { pull_request: {} })),
    JSON.stringify(issue(42, { number: -1 })),
  ])('treats malformed accepted responses as unknown', async (body) => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 201,
        headers: { 'x-github-request-id': 'ACCEPTED:123' },
      }),
    );
    await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: true,
      status: 201,
      requestId: 'ACCEPTED:123',
    });
    expect(issuePosts(fetchMock)).toHaveLength(1);
  });

  it('retains acceptance metadata when reading the creation response times out', async () => {
    vi.useFakeTimers();
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream(), {
        status: 201,
        headers: { 'x-github-request-id': 'ACCEPTED:123' },
      }),
    );
    const creation = client.create(repository, 'Title', 'Body');
    const assertion = expect(creation).rejects.toMatchObject({
      outcomeUnknown: true,
      status: 201,
      requestId: 'ACCEPTED:123',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(issuePosts(fetchMock)).toHaveLength(1);
  });

  it('drops unsafe request identifiers without exposing response bodies', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(json({ message: 'PRIVATE_BODY' }, 422, 'not a safe ID'));
    await expect(client.create(repository, 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
      requestId: undefined,
      message: 'GitHub request was rejected.',
    });
  });
});

describe('GitHubAppIssuePublisher reconciliation', () => {
  it('uses repository listing and finds the exact opaque marker while excluding PRs', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(
      json([
        issue(1, { body: `${marker} pull request`, pull_request: {} }),
        issue(2, { body: marker.replace('123', '1234') }),
        issue(3, { body: `Description\n${marker}\n` }),
      ]),
    );
    await expect(client.reconcile(repository, marker, since)).resolves.toEqual({
      number: 3,
      url: `https://github.com/${repository}/issues/3`,
    });
    const url = requestUrl(fetchMock.mock.calls[3]![0]);
    expect(url.pathname).toBe(`/repos/${repository}/issues`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      since: '2026-09-15T12:00:00.000Z',
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: '100',
      page: '1',
    });
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('scans later pages rather than accepting the first marker match as unique', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        json(
          Array.from({ length: 100 }, (_, index) =>
            issue(index + 1, { body: index === 0 ? marker : 'Unrelated' }),
          ),
        ),
      )
      .mockResolvedValueOnce(json([issue(200, { body: marker })]));
    await expect(client.reconcile(repository, marker, since)).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'Multiple GitHub issues match this publication marker. Manual review is required.',
      status: 200,
      requestId: 'AB12:CD34:EF56',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('deduplicates the same issue repeated across pages', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        json(
          Array.from({ length: 100 }, (_, index) =>
            issue(index + 1, { body: index === 0 ? marker : 'Unrelated' }),
          ),
        ),
      )
      .mockResolvedValueOnce(json([issue(1, { body: marker })]));
    await expect(client.reconcile(repository, marker, since)).resolves.toMatchObject({ number: 1 });
  });

  it('bounds reconciliation to five pages and never retries a missing publication', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    for (let page = 0; page < 5; page += 1) {
      fetchMock.mockResolvedValueOnce(
        json(Array.from({ length: 100 }, (_, index) => issue(page * 100 + index + 1))),
      );
    }
    await expect(client.reconcile(repository, marker, since)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(requestUrl(fetchMock.mock.calls[7]![0]).searchParams.get('page')).toBe('5');
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('returns undefined on a short empty page without relying on search', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(json([]));
    await expect(client.reconcile(repository, marker, since)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.some(([url]) => requestUrl(url).pathname.includes('/search/')),
    ).toBe(false);
  });

  it('can reconcile an issue in a repository archived after publication', async () => {
    const { client, fetchMock } = harness(123);
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(metadata(repository, { archived: true }))
      .mockResolvedValueOnce(json([issue(1, { body: marker })]));
    await expect(client.reconcile(repository, marker, since)).resolves.toMatchObject({ number: 1 });
    expect(issuePosts(fetchMock)).toHaveLength(0);
  });

  it('rejects a matching marker with a foreign repository URL', async () => {
    const { client, fetchMock } = harness();
    prepareAccess(fetchMock);
    fetchMock.mockResolvedValueOnce(
      json([issue(1, { body: marker, html_url: 'https://github.com/other/repo/issues/1' })]),
    );
    await expect(client.reconcile(repository, marker, since)).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub returned an invalid matching issue.',
    });
  });

  it.each([
    ['', since],
    [marker, 'invalid-date'],
  ])('rejects invalid reconciliation parameters before network access', async (value, date) => {
    const { client, fetchMock } = harness();
    await expect(client.reconcile(repository, value, date)).rejects.toMatchObject({
      outcomeUnknown: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
