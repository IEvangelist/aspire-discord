import { createHash } from 'node:crypto';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureTableIssueDraftStore } from '../../src/issues/table-store.js';
import { IssueConflictError, type IssueDraft } from '../../src/issues/types.js';
import { IssueWorkflow } from '../../src/issues/workflow.js';
import { testLogger } from '../helpers/logger.js';

const sdk = vi.hoisted(() => ({
  construct: vi.fn(),
  createEntity: vi.fn(),
  getEntity: vi.fn(),
  updateEntity: vi.fn(),
  createTable: vi.fn(),
}));

vi.mock('@azure/data-tables', () => ({
  TableClient: class {
    public readonly createEntity = sdk.createEntity;
    public readonly getEntity = sdk.getEntity;
    public readonly updateEntity = sdk.updateEntity;
    public readonly createTable = sdk.createTable;
    public constructor(...args: unknown[]) {
      sdk.construct(...args);
    }
  },
}));

const endpoint = 'https://storage.table.core.windows.net';
const credential = new DefaultAzureCredential();

function draft(): IssueDraft {
  const id = '63735215-59b0-44b8-9a75-5a7876c16c94';
  const marker = `<!-- aspire-discord-issue:${id}:1 -->`;
  const body = `Steps to reproduce.\n\n${marker}`;
  return {
    id,
    version: 1,
    actor: { userId: 'user-1', guildId: 'guild-1', channelId: 'channel-1' },
    repository: 'aspire/aspire',
    visibility: 'public',
    title: 'A bug',
    body,
    contentHash: createHash('sha256')
      .update(JSON.stringify(['aspire/aspire', 'A bug', body, 'public']))
      .digest('hex'),
    marker,
    sourceMessageIds: ['message-1'],
    notices: [],
    duplicates: [],
    createdAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-15T12:30:00.000Z',
    state: 'draft',
  };
}

function entity(value = draft()) {
  return {
    partitionKey: `${value.actor.guildId}_${value.actor.channelId}`,
    rowKey: value.id,
    draftJson: JSON.stringify(value),
    etag: 'W/"datetime\'2026-09-15T12%3A00%3A00.000Z\'"',
  };
}

beforeEach(() => {
  sdk.createEntity.mockResolvedValue({ etag: '"created"' });
  sdk.updateEntity.mockResolvedValue({ etag: '"updated"' });
  sdk.getEntity.mockResolvedValue(entity());
});

afterEach(() => {
  vi.useRealTimers();
});

function invokeOperation(
  operation: 'create' | 'get' | 'replace',
  store: AzureTableIssueDraftStore,
  value: IssueDraft,
  signal?: AbortSignal,
) {
  switch (operation) {
    case 'create':
      return store.create(value, signal);
    case 'get':
      return store.get(value.actor, value.id, signal);
    case 'replace':
      return store.replace({ draft: value, etag: '"original"' }, value, signal);
  }
}

function sdkOperation(operation: 'create' | 'get' | 'replace') {
  switch (operation) {
    case 'create':
      return sdk.createEntity;
    case 'get':
      return sdk.getEntity;
    case 'replace':
      return sdk.updateEntity;
  }
}

describe('AzureTableIssueDraftStore', () => {
  it('uses the supplied credential, a preprovisioned table and disables ambiguous SDK retries', () => {
    new AzureTableIssueDraftStore(endpoint, credential);
    expect(sdk.construct).toHaveBeenCalledWith(endpoint, 'IssueDrafts', credential, {
      retryOptions: { maxRetries: 0 },
    });
    expect(sdk.createTable).not.toHaveBeenCalled();
  });

  it('allows an explicitly configured table name', () => {
    new AzureTableIssueDraftStore(endpoint, credential, 'OtherDrafts');
    expect(sdk.construct).toHaveBeenCalledWith(
      endpoint,
      'OtherDrafts',
      credential,
      expect.any(Object),
    );
  });

  it('accepts a production managed identity without requiring a default credential chain', () => {
    const managedIdentity = new ManagedIdentityCredential({
      clientId: '11111111-1111-4111-8111-111111111111',
    });
    new AzureTableIssueDraftStore(endpoint, managedIdentity);
    expect(sdk.construct).toHaveBeenCalledWith(endpoint, 'IssueDrafts', managedIdentity, {
      retryOptions: { maxRetries: 0 },
    });
  });

  it('creates one JSON property under the exact guild/channel partition and UUID row', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    const saved = await store.create(value);
    expect(saved).toEqual({ draft: value, etag: '"created"' });
    expect(sdk.createEntity).toHaveBeenCalledExactlyOnceWith(
      {
        partitionKey: 'guild-1_channel-1',
        rowKey: value.id,
        draftJson: JSON.stringify(value),
      },
      { abortSignal: expect.any(AbortSignal), requestOptions: { timeout: 15_000 } },
    );
    expect(sdk.updateEntity).not.toHaveBeenCalled();
  });

  it('reads and schema-validates stored content and exact keys', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    await expect(store.get(value.actor, value.id)).resolves.toEqual({
      draft: value,
      etag: entity().etag,
    });
    expect(sdk.getEntity).toHaveBeenCalledExactlyOnceWith('guild-1_channel-1', value.id, {
      abortSignal: expect.any(AbortSignal),
      requestOptions: { timeout: 15_000 },
    });
  });

  it('returns undefined only for an Azure 404', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    sdk.getEntity.mockRejectedValue({ statusCode: 404 });
    await expect(store.get(value.actor, value.id)).resolves.toBeUndefined();
    for (const error of [
      { statusCode: 403 },
      { statusCode: 429 },
      { statusCode: 500 },
      new Error('Network failed'),
    ]) {
      sdk.getEntity.mockRejectedValue(error);
      await expect(store.get(value.actor, value.id)).rejects.toBe(error);
    }
  });

  it('uses conditional replace with the exact ETag, never upsert or merge', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    const replacement = {
      ...value,
      state: 'awaiting_confirmation' as const,
      previewMessageId: 'preview-1',
    };
    const saved = await store.replace({ draft: value, etag: '"original"' }, replacement);
    expect(saved).toEqual({ draft: replacement, etag: '"updated"' });
    expect(sdk.updateEntity).toHaveBeenCalledExactlyOnceWith(
      {
        partitionKey: 'guild-1_channel-1',
        rowKey: value.id,
        draftJson: JSON.stringify(replacement),
      },
      'Replace',
      {
        etag: '"original"',
        abortSignal: expect.any(AbortSignal),
        requestOptions: { timeout: 15_000 },
      },
    );
  });

  it.each(['create', 'get', 'replace'] as const)(
    'forwards caller cancellation and a request timeout to SDK %s, even if transport ignores abort',
    async (operation) => {
      const store = new AzureTableIssueDraftStore(endpoint, credential);
      const caller = new AbortController();
      const method = sdkOperation(operation);
      method.mockImplementation(() => new Promise<never>(() => undefined));
      const pending = invokeOperation(operation, store, draft(), caller.signal);
      const rejected = expect(pending).rejects.toThrow('cancelled');
      const options = method.mock.calls[0]?.[operation === 'create' ? 1 : 2] as {
        abortSignal: AbortSignal;
        requestOptions: { timeout: number };
      };
      expect(options.requestOptions.timeout).toBe(15_000);
      expect(options.abortSignal.aborted).toBe(false);
      caller.abort();
      await rejected;
      expect(options.abortSignal.aborted).toBe(true);
      expect(method).toHaveBeenCalledOnce();
    },
  );

  it.each(['create', 'get', 'replace'] as const)(
    'does not call SDK %s when already aborted',
    async (operation) => {
      const store = new AzureTableIssueDraftStore(endpoint, credential);
      await expect(
        invokeOperation(operation, store, draft(), AbortSignal.abort()),
      ).rejects.toThrow();
      expect(sdkOperation(operation)).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'get', 'replace'] as const)(
    'bounds a stalled SDK %s to 15 seconds without retry',
    async (operation) => {
      vi.useFakeTimers();
      const store = new AzureTableIssueDraftStore(endpoint, credential);
      const method = sdkOperation(operation);
      method.mockImplementation(() => new Promise<never>(() => undefined));
      const pending = invokeOperation(operation, store, draft());
      const rejected = expect(pending).rejects.toThrow('timed out');
      const options = method.mock.calls[0]?.[operation === 'create' ? 1 : 2] as {
        abortSignal: AbortSignal;
      };
      expect(options.abortSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(options.abortSignal.aborted).toBe(true);
      expect(method).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not turn a caller cancellation reason that resembles HTTP 404 into not-found', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const caller = new AbortController();
    sdk.getEntity.mockImplementation(() => new Promise<never>(() => undefined));
    const pending = store.get(draft().actor, draft().id, caller.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    caller.abort({ statusCode: 404 });
    await rejected;
  });

  it('round-trips a real workflow through the schema-checked durable state transitions', async () => {
    let saved: ReturnType<typeof entity> | undefined;
    let revision = 0;
    const persist = (value: Omit<ReturnType<typeof entity>, 'etag'>) => {
      saved = { ...value, etag: `"${++revision}"` };
      return Promise.resolve({ etag: saved.etag });
    };
    sdk.createEntity.mockImplementation(persist);
    sdk.updateEntity.mockImplementation(persist);
    sdk.getEntity.mockImplementation(() => Promise.resolve(saved));
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const actor = draft().actor;
    const workflow = new IssueWorkflow(
      store,
      {
        inspect: async () => ({
          fullName: 'aspire/aspire',
          visibility: 'public',
          issuesEnabled: true,
        }),
        findDuplicates: async () => [],
        create: async () => ({ number: 42, url: 'https://github.com/Aspire/Aspire/issues/42' }),
        reconcile: async () => undefined,
      },
      () => ({
        enabled: true,
        allowedUserIds: [actor.userId],
        allowedChannelIds: [actor.channelId],
        allowedRepositories: ['aspire/aspire'],
      }),
      testLogger,
    );
    const created = await workflow.create(actor, {
      repository: 'Aspire/Aspire',
      title: 'A bug',
      body: 'Repro steps',
      sourceMessageIds: [],
      notices: [],
    });
    const revised = await workflow.revise(actor, created.id, 1, {
      repository: 'aspire/aspire',
      title: 'An edited bug',
      body: 'Updated steps',
      sourceMessageIds: [],
      notices: [],
    });
    await workflow.attachPreview(actor, created.id, 2, 'preview-2');
    const published = await workflow.confirm(actor, created.id, 2, 'preview-2');
    expect(published.state).toBe('published');
    expect(published.contentHash).toBe(revised.contentHash);
    await expect(workflow.get(actor, created.id)).resolves.toEqual(published);
    expect(
      sdk.updateEntity.mock.calls.map(
        (call) => (JSON.parse(call[0].draftJson) as IssueDraft).state,
      ),
    ).toEqual(['draft', 'awaiting_confirmation', 'publishing', 'published']);
  });

  it.each([409, 412])(
    'returns explicit conflicts for HTTP %s without retry',
    async (statusCode) => {
      const store = new AzureTableIssueDraftStore(endpoint, credential);
      const value = draft();
      sdk.createEntity.mockRejectedValue({ statusCode });
      sdk.updateEntity.mockRejectedValue({ statusCode });
      await expect(store.create(value)).rejects.toBeInstanceOf(IssueConflictError);
      await expect(
        store.replace({ draft: value, etag: '"original"' }, value),
      ).rejects.toBeInstanceOf(IssueConflictError);
      expect(sdk.createEntity).toHaveBeenCalledOnce();
      expect(sdk.updateEntity).toHaveBeenCalledOnce();
    },
  );

  it('propagates other storage failures without converting them to successes', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    const error = new Error('Storage unavailable');
    sdk.createEntity.mockRejectedValue(error);
    sdk.updateEntity.mockRejectedValue(error);
    await expect(store.create(value)).rejects.toBe(error);
    await expect(store.replace({ draft: value, etag: '"original"' }, value)).rejects.toBe(error);
  });

  it.each(['*', '', 'not-an-etag', '"one", "two"', '"*"', 'W/"line\r\nbreak"'])(
    'rejects non-exact ETag %s before writing',
    async (etag) => {
      const store = new AzureTableIssueDraftStore(endpoint, credential);
      const value = draft();
      await expect(store.replace({ draft: value, etag }, value)).rejects.toThrow('exact ETag');
      expect(sdk.updateEntity).not.toHaveBeenCalled();
    },
  );

  it('does not claim success when Azure omits the response ETag', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    sdk.createEntity.mockResolvedValue({});
    sdk.updateEntity.mockResolvedValue({});
    const value = draft();
    await expect(store.create(value)).rejects.toThrow('exact ETag');
    await expect(store.replace({ draft: value, etag: '"original"' }, value)).rejects.toThrow(
      'exact ETag',
    );
  });

  it.each([
    { actor: { userId: 'user-2', guildId: 'guild-1', channelId: 'channel-1' } },
    { actor: { userId: 'user-1', guildId: 'guild-2', channelId: 'channel-1' } },
    { actor: { userId: 'user-1', guildId: 'guild-1', channelId: 'channel-2' } },
  ])('rejects replacement of owner or partition %j', async (change) => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    await expect(
      store.replace({ draft: value, etag: '"original"' }, { ...value, ...change }),
    ).rejects.toThrow('key or owner');
    expect(sdk.updateEntity).not.toHaveBeenCalled();
  });

  it.each([
    { partitionKey: 'another_partition' },
    { rowKey: 'another-row' },
    { draftJson: '{}' },
    { draftJson: '{"body":"secret" invalid json' },
    { draftJson: 123 },
    { etag: '*' },
  ])('rejects invalid persisted entity %j', async (change) => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    sdk.getEntity.mockResolvedValue({ ...entity(), ...change });
    await expect(store.get(value.actor, value.id)).rejects.toThrow();
  });

  it.each([
    { version: 0 },
    { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { state: 'arbitrary' },
    { state: 'published' },
    { state: 'publishing' },
    { state: 'awaiting_confirmation' },
    { state: 'draft', approvedAt: '2026-09-15T12:00:00.000Z' },
    { state: 'draft', previewMessageId: 'preview-1' },
    { repository: 'https://github.com/aspire/aspire' },
    { repository: 'aspire/..' },
    { repository: 'Aspire/Aspire' },
    { visibility: 'internal' },
    { title: 'tampered title' },
    { contentHash: 'a'.repeat(64) },
    { body: 'body without a marker' },
    { marker: '<!-- arbitrary-marker -->' },
    { actor: { userId: 'user-1', guildId: 'guild_1', channelId: 'channel-1' } },
    { sourceMessageIds: Array.from({ length: 101 }, () => 'message-1') },
    { notices: ['x'.repeat(501)] },
    { createdAt: 'not-a-date' },
    { expiresAt: '2026-09-15T11:59:00.000Z' },
    { expiresAt: '2026-09-15T12:31:00.000Z' },
    { result: { number: 1, url: 'https://evil.example/issue/1' } },
    { unexpected: 'secret' },
  ])('rejects untrusted persisted draft %j without echoing stored content', async (change) => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    sdk.getEntity.mockResolvedValue({
      ...entity(),
      draftJson: JSON.stringify({ ...value, ...change }),
    });
    await expect(store.get(value.actor, value.id)).rejects.toThrow(
      'Stored issue draft is invalid.',
    );
  });

  it('checks embedded location independently from the entity key', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    const differentLocation = { ...value, actor: { ...value.actor, guildId: 'other-guild' } };
    sdk.getEntity.mockResolvedValue({ ...entity(), draftJson: JSON.stringify(differentLocation) });
    await expect(store.get(value.actor, value.id)).rejects.toThrow('does not match its key');
  });

  it('enforces the 64 KiB property byte limit on writes and reads', async () => {
    const store = new AzureTableIssueDraftStore(endpoint, credential);
    const value = draft();
    // Each field is individually bounded; JSON escaping still pushes the aggregate past 64 KiB.
    const oversized = {
      ...value,
      notices: Array.from({ length: 10 }, () => '\u0001'.repeat(500)),
      sourceMessageIds: Array.from({ length: 100 }, () => 'x'.repeat(100)),
    };
    await expect(store.create(oversized)).rejects.toThrow('size limit');
    expect(sdk.createEntity).not.toHaveBeenCalled();
    sdk.getEntity.mockResolvedValue({ ...entity(), draftJson: ' '.repeat(65_537) });
    await expect(store.get(value.actor, value.id)).rejects.toThrow('size limit');
  });
});
