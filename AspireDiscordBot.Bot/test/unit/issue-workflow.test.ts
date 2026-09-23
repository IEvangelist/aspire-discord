import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IssueConflictError,
  IssuePolicyError,
  IssuePublishError,
  type IssueActor,
  type IssueDraft,
  type IssueDraftInput,
  type IssueDraftState,
  type IssueDraftStore,
  type IssuePolicy,
  type IssuePublisher,
  type IssueRepository,
  type StoredIssueDraft,
} from '../../src/issues/types.js';
import { IssueWorkflow } from '../../src/issues/workflow.js';
import { useTestTelemetry } from '../helpers/telemetry.js';

const spans = useTestTelemetry();
afterEach(() => {
  vi.useRealTimers();
});

const actor: IssueActor = { userId: 'user-1', guildId: 'guild-1', channelId: 'channel-1' };
const policy: IssuePolicy = {
  enabled: true,
  allowedUserIds: ['user-1', 'user-2'],
  allowedChannelIds: ['channel-1', 'channel-2'],
  allowedRepositories: ['aspire/aspire'],
};
const input: IssueDraftInput = {
  repository: 'aspire/aspire',
  title: 'A reproducible bug',
  body: 'Steps to reproduce the problem.',
  sourceMessageIds: ['message-1'],
  notices: ['Review this draft before publishing.'],
};
const repository = {
  fullName: 'aspire/aspire',
  visibility: 'public' as const,
  issuesEnabled: true,
};
const result = { number: 42, url: 'https://github.com/aspire/aspire/issues/42' };

class FakeStore implements IssueDraftStore {
  public stored: StoredIssueDraft | undefined;
  public readonly failBefore = new Set<IssueDraftState>();
  public readonly failAfter = new Set<IssueDraftState>();
  public afterReplace: ((draft: IssueDraft) => void) | undefined;
  #revision = 0;

  public async create(draft: IssueDraft, signal?: AbortSignal): Promise<StoredIssueDraft> {
    signal?.throwIfAborted();
    if (this.stored) {
      throw new IssueConflictError();
    }
    this.stored = { draft: structuredClone(draft), etag: `"${++this.#revision}"` };
    return structuredClone(this.stored);
  }

  public async get(
    location: Pick<IssueActor, 'guildId' | 'channelId'>,
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredIssueDraft | undefined> {
    signal?.throwIfAborted();
    return this.stored?.draft.id === id &&
      this.stored.draft.actor.guildId === location.guildId &&
      this.stored.draft.actor.channelId === location.channelId
      ? structuredClone(this.stored)
      : undefined;
  }

  public async replace(
    previous: StoredIssueDraft,
    draft: IssueDraft,
    signal?: AbortSignal,
  ): Promise<StoredIssueDraft> {
    signal?.throwIfAborted();
    if (previous.etag !== this.stored?.etag) {
      throw new IssueConflictError();
    }
    if (this.failBefore.has(draft.state)) {
      throw new Error('Storage connection failed: secret');
    }
    this.stored = { draft: structuredClone(draft), etag: `"${++this.#revision}"` };
    this.afterReplace?.(draft);
    if (this.failAfter.has(draft.state)) {
      throw new Error('Storage response lost: secret');
    }
    return structuredClone(this.stored);
  }
}

function fixture() {
  let currentPolicy = structuredClone(policy);
  let now = new Date('2026-09-15T12:00:00.000Z');
  const store = new FakeStore();
  const publisher = {
    inspect: vi.fn<IssuePublisher['inspect']>().mockResolvedValue(repository),
    findDuplicates: vi.fn<IssuePublisher['findDuplicates']>().mockResolvedValue([]),
    create: vi
      .fn<IssuePublisher['create']>()
      .mockImplementation(async (_repository, _title, _body, _signal, authorize) => {
        authorize?.(repository);
        return result;
      }),
    reconcile: vi.fn<IssuePublisher['reconcile']>().mockResolvedValue(undefined),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const restart = () =>
    new IssueWorkflow(store, publisher, () => currentPolicy, logger, { now: () => now });
  const workflow = restart();
  return {
    workflow,
    store,
    publisher,
    logger,
    restart,
    setPolicy: (replacement: IssuePolicy) => {
      currentPolicy = replacement;
    },
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
    ready: async () => {
      const draft = await workflow.create(actor, input);
      return await workflow.attachPreview(actor, draft.id, draft.version, 'preview-1');
    },
  };
}

describe('IssueWorkflow drafts and authorization', () => {
  it('supports server-wide drafts but binds approval to the original channel and current server permission', async () => {
    const { workflow, setPolicy, publisher } = fixture();
    setPolicy({ ...policy, allowedChannelIds: [], allowedGuildIds: [actor.guildId] });
    const threadActor = { ...actor, channelId: 'new-thread' };
    const draft = await workflow.create(threadActor, input);
    await workflow.attachPreview(threadActor, draft.id, draft.version, 'preview-1');
    await expect(
      workflow.confirm(
        { ...threadActor, channelId: 'other-thread' },
        draft.id,
        draft.version,
        'preview-1',
      ),
    ).rejects.toBeInstanceOf(IssuePolicyError);
    await expect(
      workflow.confirm(
        { ...threadActor, guildId: 'other-guild' },
        draft.id,
        draft.version,
        'preview-1',
      ),
    ).rejects.toBeInstanceOf(IssuePolicyError);
    await expect(
      workflow.confirm(
        { ...threadActor, userId: 'another-user' },
        draft.id,
        draft.version,
        'preview-1',
      ),
    ).rejects.toBeInstanceOf(IssuePolicyError);
    expect(publisher.create).not.toHaveBeenCalled();
    setPolicy({ ...policy, allowedChannelIds: [], allowedGuildIds: [] });
    await expect(
      workflow.confirm(threadActor, draft.id, draft.version, 'preview-1'),
    ).rejects.toBeInstanceOf(IssuePolicyError);
    setPolicy({ ...policy, allowedChannelIds: [], allowedGuildIds: [actor.guildId] });
    await expect(
      workflow.confirm(threadActor, draft.id, draft.version, 'preview-1'),
    ).resolves.toMatchObject({ state: 'published' });
  });
  it('rejects DMs and unapproved servers before inspecting GitHub for server-wide policies', async () => {
    for (const guildId of ['', 'other-guild']) {
      const { workflow, setPolicy, publisher } = fixture();
      setPolicy({ ...policy, allowedChannelIds: [], allowedGuildIds: [actor.guildId] });
      await expect(workflow.create({ ...actor, guildId }, input)).rejects.toBeInstanceOf(
        IssuePolicyError,
      );
      expect(publisher.inspect).not.toHaveBeenCalled();
    }
  });
  it('supports a numeric test clock and a shorter bounded draft lifetime', async () => {
    const { store, publisher, logger } = fixture();
    const workflow = new IssueWorkflow(store, publisher, () => policy, logger, {
      now: () => Date.parse('2026-09-15T12:00:00.000Z'),
      draftLifetimeMs: 1_000,
    });
    await expect(workflow.create(actor, input)).resolves.toMatchObject({
      expiresAt: '2026-09-15T12:00:01.000Z',
    });
  });

  it.each([0, -1, 1.5, 1_800_001, NaN])(
    'rejects an invalid draft lifetime %s',
    (draftLifetimeMs) => {
      const { store, publisher, logger } = fixture();
      expect(
        () => new IssueWorkflow(store, publisher, () => policy, logger, { draftLifetimeMs }),
      ).toThrow('draft lifetime');
    },
  );

  it('persists canonical content, duplicate warnings, marker, exact hash and a 30-minute expiry', async () => {
    const { workflow, publisher, store } = fixture();
    publisher.findDuplicates.mockResolvedValue([{ ...result, title: 'A similar issue' }]);
    const draft = await workflow.create(actor, {
      ...input,
      repository: ' Aspire/Aspire ',
      title: ' A bug ',
    });

    expect(draft.repository).toBe('aspire/aspire');
    expect(draft.title).toBe('A bug');
    expect(draft.version).toBe(1);
    expect(draft.state).toBe('draft');
    expect(draft.marker).toBe(`<!-- aspire-discord-issue:${draft.id}:1 -->`);
    expect(draft.body).toBe(`${input.body}\n\n${draft.marker}`);
    expect(draft.contentHash).toBe(
      createHash('sha256')
        .update(JSON.stringify([draft.repository, draft.title, draft.body, 'public']))
        .digest('hex'),
    );
    expect(draft.expiresAt).toBe('2026-09-15T12:30:00.000Z');
    expect(draft.duplicates).toEqual([{ ...result, title: 'A similar issue' }]);
    expect(store.stored?.draft).toEqual(draft);
    expect(publisher.create).not.toHaveBeenCalled();
    expect(publisher.inspect).toHaveBeenCalledWith('aspire/aspire', undefined);
    expect(publisher.findDuplicates).toHaveBeenCalledWith('aspire/aspire', 'A bug', undefined);
  });

  it.each([
    { ...policy, enabled: false },
    { ...policy, allowedUserIds: [] },
    { ...policy, allowedChannelIds: [] },
    { ...policy, allowedRepositories: [] },
    { ...policy, allowedRepositories: [''] },
    { ...policy, allowedRepositories: ['other/repository'] },
    { ...policy, allowedUserIds: ['another-user'] },
    { ...policy, allowedChannelIds: ['another-channel'] },
  ])('fails closed under policy %j', async (deniedPolicy) => {
    const { workflow, setPolicy, publisher } = fixture();
    setPolicy(deniedPolicy);
    await expect(workflow.create(actor, input)).rejects.toBeInstanceOf(IssuePolicyError);
    expect(publisher.inspect).not.toHaveBeenCalled();
  });

  it.each([
    'https://github.com/aspire/aspire',
    'aspire/../aspire',
    'aspire/..',
    '-aspire/aspire',
    'aspire/repo?x=1',
  ])('rejects malformed repository %s', async (name) => {
    const { workflow, publisher } = fixture();
    await expect(workflow.create(actor, { ...input, repository: name })).rejects.toBeInstanceOf(
      IssuePolicyError,
    );
    expect(publisher.inspect).not.toHaveBeenCalled();
  });

  it.each([
    { title: 'x'.repeat(181) },
    { title: 'two\nlines' },
    { body: 'x'.repeat(3_501) },
    { body: 'injected <!-- aspire-discord-issue:other:1 -->' },
    { title: 'ASPIRE-DISCORD-ISSUE:injected' },
    { sourceMessageIds: Array.from({ length: 101 }, (_, index) => `message-${index}`) },
    { notices: Array.from({ length: 11 }, () => 'notice') },
    { notices: ['x'.repeat(501)] },
  ])('rejects oversized or marker-injecting content %j', async (change) => {
    const { workflow, publisher } = fixture();
    await expect(workflow.create(actor, { ...input, ...change })).rejects.toBeInstanceOf(
      IssuePolicyError,
    );
    expect(publisher.inspect).not.toHaveBeenCalled();
  });

  it('accepts the exact pre-marker title/body bounds', async () => {
    const { workflow } = fixture();
    const draft = await workflow.create(actor, {
      ...input,
      title: 'x'.repeat(180),
      body: 'x'.repeat(3_500),
    });
    expect(draft.body).toBe(`${'x'.repeat(3_500)}\n\n${draft.marker}`);
  });

  it.each([
    { body: 'My password=not-for-publication' },
    { title: 'Email person@example.com about this bug' },
    { body: 'See https://discord.com/channels/123/456/789 for details' },
    { body: 'Reproduction <!-- hidden instructions -->' },
    { body: 'Please notify @everyone' },
    { title: 'Bug reported by @somebody' },
    { body: `The authorization header is Bearer ${'a'.repeat(30)}` },
  ])(
    'rejects sensitive raw create and revise content at the workflow boundary: %j',
    async (change) => {
      const { workflow, ready, publisher, store } = fixture();
      await expect(workflow.create(actor, { ...input, ...change })).rejects.toBeInstanceOf(
        IssuePolicyError,
      );
      expect(publisher.inspect).not.toHaveBeenCalled();
      expect(store.stored).toBeUndefined();
      const original = await ready();
      publisher.inspect.mockClear();
      await expect(
        workflow.revise(actor, original.id, 1, { ...input, ...change }),
      ).rejects.toBeInstanceOf(IssuePolicyError);
      expect(publisher.inspect).not.toHaveBeenCalled();
      expect(store.stored?.draft).toEqual(original);
      expect(publisher.create).not.toHaveBeenCalled();
    },
  );

  it('does not store a draft before repository and duplicate reads succeed', async () => {
    const { workflow, publisher, store } = fixture();
    publisher.findDuplicates.mockRejectedValue(new Error('Duplicate search unavailable'));
    await expect(workflow.create(actor, input)).rejects.toThrow('Duplicate search unavailable');
    expect(store.stored).toBeUndefined();
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it('rejects a repository with issues disabled', async () => {
    const { workflow, publisher } = fixture();
    publisher.inspect.mockResolvedValue({ ...repository, issuesEnabled: false });
    await expect(workflow.create(actor, input)).rejects.toBeInstanceOf(IssuePolicyError);
    expect(publisher.findDuplicates).not.toHaveBeenCalled();
  });

  it.each([
    { ...actor, userId: 'user-2' },
    { ...actor, channelId: 'channel-2' },
    { ...actor, guildId: 'guild-2' },
  ])('rejects a different owner or location %j', async (otherActor) => {
    const { workflow, ready, publisher } = fixture();
    const draft = await ready();
    await expect(workflow.get(otherActor, draft.id)).rejects.toBeInstanceOf(IssuePolicyError);
    await expect(workflow.confirm(otherActor, draft.id, 1, 'preview-1')).rejects.toBeInstanceOf(
      IssuePolicyError,
    );
    await expect(workflow.revise(otherActor, draft.id, 1, input)).rejects.toBeInstanceOf(
      IssuePolicyError,
    );
    await expect(workflow.cancel(otherActor, draft.id, 1)).rejects.toBeInstanceOf(IssuePolicyError);
    await expect(workflow.reconcile(otherActor, draft.id)).rejects.toBeInstanceOf(IssuePolicyError);
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it('requires current policy for every draft read', async () => {
    const { workflow, ready, setPolicy } = fixture();
    const draft = await ready();
    setPolicy({ ...policy, allowedRepositories: ['another/repository'] });
    await expect(workflow.get(actor, draft.id)).rejects.toBeInstanceOf(IssuePolicyError);
  });

  it('expires drafts at the boundary without posting', async () => {
    const { workflow, ready, advance, publisher } = fixture();
    const draft = await ready();
    advance(30 * 60 * 1_000);
    await expect(workflow.get(actor, draft.id)).rejects.toThrow('expired');
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).rejects.toThrow('expired');
    await expect(workflow.revise(actor, draft.id, 1, input)).rejects.toThrow('expired');
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it('permits explicitly requested expired status reads without relaxing owner or live policy checks', async () => {
    const { workflow, ready, publisher, advance, setPolicy } = fixture();
    const draft = await ready();
    publisher.create.mockRejectedValue(new IssuePublishError('Response lost', true));
    await workflow.confirm(actor, draft.id, 1, 'preview-1');
    advance(31 * 60 * 1_000);
    await expect(workflow.get(actor, draft.id)).rejects.toThrow('expired');
    await expect(workflow.get(actor, draft.id, { allowExpired: true })).resolves.toMatchObject({
      state: 'unknown',
    });
    await expect(
      workflow.get({ ...actor, userId: 'user-2' }, draft.id, { allowExpired: true }),
    ).rejects.toBeInstanceOf(IssuePolicyError);
    setPolicy({ ...policy, enabled: false });
    await expect(workflow.get(actor, draft.id, { allowExpired: true })).rejects.toBeInstanceOf(
      IssuePolicyError,
    );
    setPolicy(policy);
    publisher.reconcile.mockResolvedValue(result);
    await expect(workflow.reconcile(actor, draft.id)).resolves.toMatchObject({
      state: 'published',
    });
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it('forwards the caller signal for create/get/revise/preview/cancel storage operations', async () => {
    const { workflow, store } = fixture();
    const create = vi.spyOn(store, 'create');
    const get = vi.spyOn(store, 'get');
    const replace = vi.spyOn(store, 'replace');
    const signal = new AbortController().signal;
    const draft = await workflow.create(actor, input, signal);
    expect(create).toHaveBeenCalledWith(expect.any(Object), signal);
    await workflow.get(actor, draft.id, { signal });
    await workflow.revise(actor, draft.id, 1, input, signal);
    await workflow.attachPreview(actor, draft.id, 2, 'preview-2', signal);
    await workflow.cancel(actor, draft.id, 2, signal);
    expect(get.mock.calls.every((call) => call[2] === signal)).toBe(true);
    expect(replace.mock.calls.every((call) => call[2] === signal)).toBe(true);
  });

  it('revisions supersede previews, marker and hash without extending original expiry', async () => {
    const { workflow, ready, advance, publisher } = fixture();
    const original = await ready();
    advance(10 * 60 * 1_000);
    const revised = await workflow.revise(actor, original.id, 1, {
      ...input,
      title: 'Revised bug',
    });
    expect(revised).toMatchObject({
      id: original.id,
      version: 2,
      state: 'draft',
      title: 'Revised bug',
      createdAt: original.createdAt,
      expiresAt: original.expiresAt,
    });
    expect(revised.marker).toBe(`<!-- aspire-discord-issue:${original.id}:2 -->`);
    expect(revised.body).not.toContain(original.marker);
    expect(revised.contentHash).not.toBe(original.contentHash);
    expect(revised.previewMessageId).toBeUndefined();
    expect(revised.approvedAt).toBeUndefined();
    await expect(workflow.confirm(actor, original.id, 1, 'preview-1')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    await expect(workflow.confirm(actor, original.id, 2, 'preview-1')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    const attached = await workflow.attachPreview(actor, original.id, 2, 'preview-2');
    const published = await workflow.confirm(actor, original.id, 2, 'preview-2');
    expect(published.contentHash).toBe(attached.contentHash);
    expect(publisher.create).toHaveBeenCalledExactlyOnceWith(
      attached.repository,
      attached.title,
      attached.body,
      undefined,
      expect.any(Function),
    );
  });

  it('allows exactly one preview attachment for a version', async () => {
    const { workflow, ready } = fixture();
    const draft = await ready();
    await expect(workflow.attachPreview(actor, draft.id, 1, 'preview-2')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
  });

  it.each([0, 2, 1.1, NaN, Infinity])('rejects invalid or stale version %s', async (version) => {
    const { workflow, ready, publisher } = fixture();
    const draft = await ready();
    await expect(workflow.confirm(actor, draft.id, version, 'preview-1')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    await expect(workflow.revise(actor, draft.id, version, input)).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    await expect(workflow.cancel(actor, draft.id, version)).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it('rejects a confirmation from a different preview message', async () => {
    const { workflow, ready, publisher } = fixture();
    const draft = await ready();
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-2')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    expect(publisher.create).not.toHaveBeenCalled();
  });
});

describe('IssueWorkflow durable publication', () => {
  it('records sanitized outcomes and spans without content or actor identifiers', async () => {
    const { workflow, ready, publisher, logger } = fixture();
    const draft = await ready();
    publisher.create.mockRejectedValue(new IssuePublishError('secret title and token', false, 422));
    await workflow.confirm(actor, draft.id, 1, 'preview-1');
    const finished = spans.getFinishedSpans();
    expect(finished.map((span) => span.name)).toEqual([
      'issue create',
      'issue attach_preview',
      'issue confirm',
    ]);
    expect(finished.at(-1)?.attributes).toMatchObject({
      'aspire.issues.action': 'confirm',
      'aspire.issues.outcome': 'failed',
    });
    expect(finished.at(-1)?.events).toEqual([]);
    expect(JSON.stringify(finished.map((span) => span.attributes))).not.toContain(actor.userId);
    expect(logger.error).toHaveBeenCalledWith(
      { action: 'publish', outcome: 'failed', httpStatus: 422 },
      'GitHub issue publication failed.',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });

  it('accepts case-preserving GitHub issue URLs for the canonical repository', async () => {
    const { workflow, ready, publisher } = fixture();
    const draft = await ready();
    publisher.create.mockResolvedValue({
      ...result,
      url: 'https://github.com/Aspire/Aspire/issues/42',
    });
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).resolves.toMatchObject({
      state: 'published',
    });
  });

  it('allows only one POST across concurrent workflow instances', async () => {
    const { workflow, ready, publisher, restart } = fixture();
    const draft = await ready();
    const gate = Promise.withResolvers<typeof repository>();
    publisher.inspect.mockReturnValue(gate.promise);
    const first = workflow.confirm(actor, draft.id, 1, 'preview-1');
    const second = restart().confirm(actor, draft.id, 1, 'preview-1');
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => {
      expect(publisher.inspect).toHaveBeenCalledTimes(3);
    });
    gate.resolve(repository);
    const outcomes = await settled;
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it('returns the approved published version idempotently even after expiry', async () => {
    const { workflow, ready, advance, publisher } = fixture();
    const draft = await ready();
    const published = await workflow.confirm(actor, draft.id, 1, 'preview-1');
    advance(60 * 60 * 1_000);
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).resolves.toEqual(published);
    await expect(workflow.confirm(actor, draft.id, 1, 'wrong-preview')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it('rechecks policy when the repository inspection finishes', async () => {
    const { workflow, ready, publisher, setPolicy, store } = fixture();
    const draft = await ready();
    const gate = Promise.withResolvers<typeof repository>();
    publisher.inspect.mockReturnValue(gate.promise);
    const confirmation = workflow.confirm(actor, draft.id, 1, 'preview-1');
    const rejected = expect(confirmation).rejects.toBeInstanceOf(IssuePolicyError);
    await vi.waitFor(() => {
      expect(publisher.inspect).toHaveBeenCalledTimes(2);
    });
    setPolicy({ ...policy, enabled: false });
    gate.resolve(repository);
    await rejected;
    expect(publisher.create).not.toHaveBeenCalled();
    expect(store.stored?.draft.state).toBe('awaiting_confirmation');
  });

  it('rechecks expiry when the repository inspection finishes', async () => {
    const { workflow, ready, publisher, advance } = fixture();
    const draft = await ready();
    publisher.inspect.mockImplementation(async () => {
      advance(30 * 60 * 1_000);
      return repository;
    });
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).rejects.toThrow('expired');
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it.each([
    { ...repository, visibility: 'private' as const },
    { ...repository, issuesEnabled: false },
    { ...repository, fullName: 'other/repository' },
  ])('requires a fresh draft if repository inspection changes %j', async (changed) => {
    const { workflow, ready, publisher, store } = fixture();
    const draft = await ready();
    publisher.inspect.mockResolvedValue(changed);
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).rejects.toBeInstanceOf(
      IssuePolicyError,
    );
    expect(store.stored?.draft.state).toBe('awaiting_confirmation');
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it('checks policy again after the durable claim, immediately before POST', async () => {
    const { workflow, ready, publisher, store, setPolicy } = fixture();
    const draft = await ready();
    store.afterReplace = (replacement) => {
      if (replacement.state === 'publishing') {
        setPolicy({ ...policy, enabled: false });
      }
    };
    const failed = await workflow.confirm(actor, draft.id, 1, 'preview-1');
    expect(failed.state).toBe('failed');
    expect(store.stored?.draft.state).toBe('failed');
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it.each([
    'disabled',
    'owner-revoked',
    'repository-revoked',
    'expired',
    'visibility-changed',
    'issues-disabled',
  ])('prevents POST when %s changes during publisher authentication awaits', async (change) => {
    const { workflow, ready, publisher, store, setPolicy, advance } = fixture();
    const draft = await ready();
    const gate = Promise.withResolvers<undefined>();
    const post = vi.fn();
    let fresh: IssueRepository = repository;
    publisher.create.mockImplementation(async (_repository, _title, _body, _signal, authorize) => {
      await gate.promise;
      authorize?.(fresh);
      post();
      return result;
    });
    const confirmation = workflow.confirm(actor, draft.id, 1, 'preview-1');
    await vi.waitFor(() => {
      expect(publisher.create).toHaveBeenCalledOnce();
    });
    expect(store.stored?.draft.state).toBe('publishing');
    switch (change) {
      case 'disabled':
        setPolicy({ ...policy, enabled: false });
        break;
      case 'owner-revoked':
        setPolicy({ ...policy, allowedUserIds: ['user-2'] });
        break;
      case 'repository-revoked':
        setPolicy({ ...policy, allowedRepositories: ['another/repository'] });
        break;
      case 'expired':
        advance(30 * 60 * 1_000);
        break;
      case 'visibility-changed':
        fresh = { ...repository, visibility: 'private' };
        break;
      case 'issues-disabled':
        fresh = { ...repository, issuesEnabled: false };
        break;
    }
    gate.resolve(undefined);
    await expect(confirmation).resolves.toMatchObject({ state: 'failed' });
    expect(store.stored?.draft.state).toBe('failed');
    expect(post).not.toHaveBeenCalled();
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it('rechecks the approved content hash before allowing a publisher POST', async () => {
    const { workflow, ready, publisher, store } = fixture();
    const draft = await ready();
    const replace = store.replace.bind(store);
    vi.spyOn(store, 'replace').mockImplementation(async (previous, replacement) => {
      const saved = await replace(previous, replacement);
      return saved.draft.state === 'publishing'
        ? { ...saved, draft: { ...saved.draft, contentHash: 'a'.repeat(64) } }
        : saved;
    });
    const post = vi.fn();
    publisher.create.mockImplementation(async (_repository, _title, _body, _signal, authorize) => {
      authorize?.(repository);
      post();
      return result;
    });
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).resolves.toMatchObject({
      state: 'failed',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [new IssuePublishError('422 rejected: secret title/body', false, 422), 'failed'],
    [new IssuePublishError('Response lost: secret title/body', true, 503), 'unknown'],
    [new Error('Network disconnected: secret title/body'), 'unknown'],
  ] as const)('persists a safe terminal/uncertain outcome for %s', async (error, state) => {
    const { workflow, ready, publisher, store, logger } = fixture();
    const draft = await ready();
    publisher.create.mockRejectedValue(error);
    const outcome = await workflow.confirm(actor, draft.id, 1, 'preview-1');
    expect(outcome.state).toBe(state);
    expect(outcome.approvedAt).toBe('2026-09-15T12:00:00.000Z');
    expect(outcome.result).toBeUndefined();
    expect(store.stored?.draft).toEqual(outcome);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(input.title);
    expect(logger.error).toHaveBeenCalledWith(
      { action: 'confirm', outcome: state },
      'Issue workflow action did not complete publication.',
    );
    if (state === 'unknown') {
      await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).resolves.toEqual(outcome);
    } else {
      await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).rejects.toBeInstanceOf(
        IssueConflictError,
      );
    }
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it('leaves a durable claim if saving a successful GitHub response fails, then reconciles after restart', async () => {
    const { workflow, ready, publisher, store, advance, restart } = fixture();
    const draft = await ready();
    store.failBefore.add('published');
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).rejects.toMatchObject({
      name: 'IssuePublishError',
      outcomeUnknown: true,
    });
    expect(store.stored?.draft.state).toBe('publishing');
    expect(store.stored?.draft.approvedAt).toBeDefined();
    advance(60 * 60 * 1_000);
    await expect(restart().confirm(actor, draft.id, 1, 'preview-1')).resolves.toMatchObject({
      state: 'publishing',
    });
    store.failBefore.clear();
    publisher.reconcile.mockResolvedValue(result);
    const reconciled = await restart().reconcile(actor, draft.id);
    expect(reconciled.state).toBe('published');
    expect(reconciled.result).toEqual(result);
    expect(reconciled.contentHash).toBe(draft.contentHash);
    expect(publisher.reconcile).toHaveBeenCalledExactlyOnceWith(
      draft.repository,
      draft.marker,
      '2026-09-15T12:00:00.000Z',
      undefined,
    );
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it('forwards caller signals through confirm/reconcile reads and the publishing claim', async () => {
    const { workflow, ready, publisher, store } = fixture();
    const draft = await ready();
    const signal = new AbortController().signal;
    const get = vi.spyOn(store, 'get');
    const replace = vi.spyOn(store, 'replace');
    publisher.create.mockRejectedValue(new IssuePublishError('Response lost', true));
    await workflow.confirm(actor, draft.id, 1, 'preview-1', signal);
    expect(get).toHaveBeenLastCalledWith(actor, draft.id, signal);
    expect(replace.mock.calls.find((call) => call[1].state === 'publishing')?.[2]).toBe(signal);
    const recoverySignal = replace.mock.calls.find((call) => call[1].state === 'unknown')?.[2];
    expect(recoverySignal).toBeInstanceOf(AbortSignal);
    expect(recoverySignal).not.toBe(signal);
    expect(recoverySignal?.aborted).toBe(false);
    publisher.reconcile.mockResolvedValue(result);
    await workflow.reconcile(actor, draft.id, signal);
    expect(get).toHaveBeenLastCalledWith(actor, draft.id, signal);
    expect(publisher.reconcile).toHaveBeenLastCalledWith(
      draft.repository,
      draft.marker,
      draft.createdAt,
      signal,
    );
  });

  it.each(['published', 'unknown'] as const)(
    'persists %s with a fresh recovery signal when the caller aborts after POST dispatch',
    async (state) => {
      const { workflow, ready, publisher, store } = fixture();
      const draft = await ready();
      const caller = new AbortController();
      const replace = vi.spyOn(store, 'replace');
      publisher.create.mockImplementation(
        async (_repository, _title, _body, _signal, authorize) => {
          authorize?.(repository);
          caller.abort();
          if (state === 'unknown') {
            throw new IssuePublishError('Response lost after dispatch', true);
          }
          return result;
        },
      );
      await expect(
        workflow.confirm(actor, draft.id, 1, 'preview-1', caller.signal),
      ).resolves.toMatchObject({ state });
      const persistenceSignal = replace.mock.calls.at(-1)?.[2];
      expect(persistenceSignal).toBeInstanceOf(AbortSignal);
      expect(persistenceSignal).not.toBe(caller.signal);
      expect(persistenceSignal?.aborted).toBe(false);
      expect(store.stored?.draft.state).toBe(state);
    },
  );

  it('persists a definite failure with a fresh signal if the caller aborts before the final POST guard', async () => {
    const { workflow, ready, publisher, store } = fixture();
    const draft = await ready();
    const caller = new AbortController();
    const post = vi.fn();
    publisher.create.mockImplementation(async (_repository, _title, _body, _signal, authorize) => {
      caller.abort();
      authorize?.(repository);
      post();
      return result;
    });
    await expect(
      workflow.confirm(actor, draft.id, 1, 'preview-1', caller.signal),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(store.stored?.draft.state).toBe('failed');
    expect(post).not.toHaveBeenCalled();
  });

  it('bounds stalled status persistence after POST and never submits the issue again', async () => {
    const { workflow, ready, publisher, store, restart } = fixture();
    const draft = await ready();
    vi.useFakeTimers();
    const persistenceStarted = Promise.withResolvers<undefined>();
    const replace = store.replace.bind(store);
    let recoverySignal: AbortSignal | undefined;
    const replacement = vi
      .spyOn(store, 'replace')
      .mockImplementation(async (previous, value, signal) => {
        if (value.state === 'published') {
          recoverySignal = signal;
          persistenceStarted.resolve(undefined);
          return await new Promise<never>(() => undefined);
        }
        return await replace(previous, value, signal);
      });
    const pending = workflow.confirm(actor, draft.id, 1, 'preview-1');
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'IssuePublishError',
      outcomeUnknown: true,
    });
    await persistenceStarted.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(recoverySignal?.aborted).toBe(true);
    expect(store.stored?.draft.state).toBe('publishing');
    await expect(restart().confirm(actor, draft.id, 1, 'preview-1')).resolves.toMatchObject({
      state: 'publishing',
    });
    replacement.mockRestore();
    publisher.reconcile.mockResolvedValue(result);
    await expect(restart().reconcile(actor, draft.id)).resolves.toMatchObject({
      state: 'published',
    });
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it('does not POST after an ambiguous claim response or retry creation during reconciliation', async () => {
    const { workflow, ready, publisher, store } = fixture();
    const draft = await ready();
    store.failAfter.add('publishing');
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).rejects.toMatchObject({
      name: 'IssuePublishError',
      outcomeUnknown: true,
    });
    expect(store.stored?.draft.state).toBe('publishing');
    await expect(workflow.reconcile(actor, draft.id)).resolves.toMatchObject({ state: 'unknown' });
    await expect(workflow.reconcile(actor, draft.id)).resolves.toMatchObject({ state: 'unknown' });
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).resolves.toMatchObject({
      state: 'unknown',
    });
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it('requires current owner and policy even when reconciling expired uncertainty', async () => {
    const { workflow, ready, publisher, advance, setPolicy } = fixture();
    const draft = await ready();
    publisher.create.mockRejectedValue(new Error('Response lost'));
    await workflow.confirm(actor, draft.id, 1, 'preview-1');
    advance(60 * 60 * 1_000);
    await expect(
      workflow.reconcile({ ...actor, userId: 'user-2' }, draft.id),
    ).rejects.toBeInstanceOf(IssuePolicyError);
    setPolicy({ ...policy, enabled: false });
    await expect(workflow.reconcile(actor, draft.id)).rejects.toBeInstanceOf(IssuePolicyError);
    expect(publisher.reconcile).not.toHaveBeenCalled();
    setPolicy(policy);
    await expect(workflow.reconcile(actor, draft.id)).resolves.toMatchObject({ state: 'unknown' });
  });

  it('cancels editable drafts and rejects every subsequent mutating action', async () => {
    const { workflow, ready, publisher } = fixture();
    const draft = await ready();
    await expect(workflow.cancel(actor, draft.id, 1)).resolves.toMatchObject({
      state: 'cancelled',
    });
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    await expect(workflow.revise(actor, draft.id, 1, input)).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    await expect(workflow.attachPreview(actor, draft.id, 1, 'preview-2')).rejects.toBeInstanceOf(
      IssueConflictError,
    );
    await expect(workflow.reconcile(actor, draft.id)).rejects.toBeInstanceOf(IssueConflictError);
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it.each(['publishing', 'published', 'unknown', 'failed'] as const)(
    'cannot cancel or revise a %s draft',
    async (state) => {
      const { workflow, ready, store } = fixture();
      const draft = await ready();
      store.stored = {
        etag: '"forced"',
        draft: {
          ...draft,
          state,
          approvedAt: draft.createdAt,
          ...(state === 'published' ? { result } : {}),
        },
      };
      await expect(workflow.cancel(actor, draft.id, 1)).rejects.toBeInstanceOf(IssueConflictError);
      await expect(workflow.revise(actor, draft.id, 1, input)).rejects.toBeInstanceOf(
        IssueConflictError,
      );
    },
  );

  it('does not claim or POST with an already aborted signal', async () => {
    const { workflow, ready, publisher, store } = fixture();
    const draft = await ready();
    const signal = AbortSignal.abort();
    await expect(workflow.confirm(actor, draft.id, 1, 'preview-1', signal)).rejects.toThrow();
    expect(store.stored?.draft.state).toBe('awaiting_confirmation');
    expect(publisher.create).not.toHaveBeenCalled();
  });
});
