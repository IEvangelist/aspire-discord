import type {
  ButtonInteraction,
  Message,
  MessageCreateOptions,
  MessageEditOptions,
  User,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { DiscordIssueController } from '../../src/discord/issue-controller.js';
import { IssueDraftGenerator } from '../../src/issues/drafting.js';
import { IssueWorkflow } from '../../src/issues/workflow.js';
import {
  IssueConflictError,
  IssuePublishError,
  type IssueDraftStore,
  type IssuePolicy,
  type IssuePublisher,
  type StoredIssueDraft,
} from '../../src/issues/types.js';
import { testLogger } from '../helpers/logger.js';
import type { PreparedIssueFields } from '../../src/domain.js';

const policy: IssuePolicy = {
  enabled: true,
  allowedUserIds: ['123'],
  allowedChannelIds: ['456'],
  allowedRepositories: ['microsoft/aspire'],
};
const bot = { id: '999' } as User;
const repository = {
  fullName: 'microsoft/aspire',
  visibility: 'public' as const,
  issuesEnabled: true,
};

function durableTestStore(): IssueDraftStore {
  const rows = new Map<string, StoredIssueDraft>();
  return {
    async create(draft) {
      if (rows.has(draft.id)) throw new IssueConflictError();
      const row = { draft: structuredClone(draft), etag: '1' };
      rows.set(draft.id, row);
      return structuredClone(row);
    },
    async get(actor, id) {
      const row = rows.get(id);
      return row?.draft.actor.channelId === actor.channelId &&
        row.draft.actor.guildId === actor.guildId
        ? structuredClone(row)
        : undefined;
    },
    async replace(previous, draft) {
      if (rows.get(draft.id)?.etag !== previous.etag) throw new IssueConflictError();
      const row = { draft: structuredClone(draft), etag: String(Number(previous.etag) + 1) };
      rows.set(draft.id, row);
      return structuredClone(row);
    },
  };
}

function environment(activePolicy: IssuePolicy = policy) {
  let now = Date.now();
  const store = durableTestStore();
  const create = vi.fn<IssuePublisher['create']>(
    async (_repository, _title, _body, _signal, authorize) => {
      authorize?.(repository);
      return { number: 42, url: 'https://github.com/microsoft/aspire/issues/42' };
    },
  );
  const reconcile = vi.fn<IssuePublisher['reconcile']>(async () => undefined);
  const publisher: IssuePublisher = {
    inspect: async () => repository,
    findDuplicates: async () => [],
    create,
    reconcile,
  };
  const complete = vi.fn(async () =>
    JSON.stringify({
      kind: 'draft',
      repository: 'microsoft/aspire',
      title: 'Reported deployment failure',
      body: '## Observed\nThe reporter sees deployment fail.\n## Reproduction\nNot provided.',
    }),
  );
  const generator = new IssueDraftGenerator({ complete });
  const controller = () =>
    new DiscordIssueController(
      {
        generator,
        workflow: new IssueWorkflow(store, publisher, () => activePolicy, testLogger, {
          now: () => now,
        }),
      },
      () => activePolicy,
      testLogger,
    );
  return {
    controller,
    create,
    reconcile,
    complete,
    setPolicy: (next: IssuePolicy) => {
      activePolicy = next;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function requestPreview(
  controller: DiscordIssueController,
  input: PreparedIssueFields = {
    repository: 'microsoft/aspire',
    title: 'Reported deployment failure',
    body: '## Observed\nThe reporter sees deployment fail.\n## Reproduction\nNot provided.',
  },
  content = '<@999> Please file an issue about a deployment failure.',
  delivery: 'reply' | 'edit' = 'reply',
) {
  const previews: (MessageCreateOptions | MessageEditOptions)[] = [];
  const reply = vi.fn(async (payload: MessageCreateOptions) => {
    previews.push(payload);
    return { id: '900001' };
  });
  const progress = {
    id: '900001',
    edit: vi.fn(async (payload: MessageEditOptions) => {
      previews.push(payload);
    }),
  };
  const message = {
    id: '111',
    author: { id: '123', bot: false },
    content,
    guildId: '789',
    channelId: '456',
    createdTimestamp: Date.now(),
    channel: { isThread: () => false },
    mentions: { has: () => true },
    reference: null,
    reply,
  } as unknown as Message;
  const receipt = await controller.prepareDraft(
    message,
    bot,
    input,
    undefined,
    delivery === 'edit' ? progress : undefined,
  );
  const preview = previews[0];
  const match = /Issue draft: ([a-f0-9-]{36}) v(\d+)\./u.exec(preview?.content ?? '');
  if (!preview || !match?.[1] || !match[2]) {
    throw new Error(`A complete draft preview was expected: ${String(preview?.content)}`);
  }
  return { preview, id: match[1], version: match[2], reply, progress, receipt };
}

function confirmation(id: string, version: string, action = 'confirm', previewId = '900001') {
  const editReply = vi.fn(async () => undefined);
  const interaction = {
    id: '777',
    customId: `issue:${action}:${id}:${version}`,
    user: { id: '123' },
    guildId: '789',
    channelId: '456',
    message: { id: previewId, edit: async () => undefined },
    deferReply: async () => undefined,
    editReply,
    reply: async () => undefined,
  } as unknown as ButtonInteraction;
  return { interaction, editReply };
}

describe('conversation-to-issue publication', () => {
  it('previews the prepared Testing / 1.2.3 fields without rewriting or publishing', async () => {
    const app = environment();
    const { preview, id, reply, progress, receipt } = await requestPreview(
      app.controller(),
      { repository: 'microsoft/aspire', title: 'Testing', body: '1.2.3' },
      'aspire.dev',
      'edit',
    );
    expect(app.complete).not.toHaveBeenCalled();
    expect(app.create).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(progress.edit).toHaveBeenCalledOnce();
    expect(receipt).toEqual({ draftId: id, version: 1 });
    expect(preview.files ?? []).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(preview.embeds))).toEqual([
      expect.objectContaining({
        title: 'Testing',
        description: `1.2.3\n\n<!-- aspire-discord-issue:${id}:1 -->`,
      }),
    ]);
  });

  it('publishes the entire approved 3500-character body and opaque marker from the edited preview', async () => {
    const app = environment();
    const input = {
      repository: 'microsoft/aspire',
      title: 'Reported deployment failure',
      body: `${'Observed deployment failure on Windows.\n'.repeat(100).slice(0, 3_499)}!`,
    };
    const { preview, id, version, reply, progress } = await requestPreview(
      app.controller(),
      input,
      undefined,
      'edit',
    );
    const embed = preview.embeds?.[0];
    const displayed = embed && 'toJSON' in embed ? embed.toJSON() : embed;
    expect(input.body).toHaveLength(3_500);
    expect(displayed?.title).toBe(input.title);
    expect(displayed?.description).toBe(`${input.body}\n\n<!-- aspire-discord-issue:${id}:1 -->`);
    expect(preview.files ?? []).toHaveLength(0);
    expect(reply).not.toHaveBeenCalled();
    expect(progress.edit).toHaveBeenCalledOnce();
    expect(app.create).not.toHaveBeenCalled();
    await app.controller().handleButton(confirmation(id, version).interaction);
    expect(app.create).toHaveBeenCalledExactlyOnceWith(
      input.repository,
      input.title,
      displayed?.description,
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it('keeps revision identity and invalidates the old preview after a clarification', async () => {
    const app = environment();
    const { preview, id, version, progress } = await requestPreview(
      app.controller(),
      undefined,
      undefined,
      'edit',
    );
    const previewMessage = { id: '900001', author: bot, content: preview.content };
    const clarificationReplies: MessageCreateOptions[] = [];
    const revisionFields = {
      id: '222',
      author: { id: '123', bot: false },
      content: 'Change the reproduction.',
      guildId: '789',
      channelId: '456',
      createdTimestamp: Date.now(),
      channel: { isThread: () => false },
      mentions: { has: () => false },
      reference: { messageId: '900001', channelId: '456' },
      fetchReference: async () => previewMessage,
      reply: async (payload: MessageCreateOptions) => {
        clarificationReplies.push(payload);
        return { id: '900002' };
      },
    };
    const revisionMessage = revisionFields as unknown as Message;
    app.complete.mockResolvedValueOnce(
      JSON.stringify({ kind: 'clarification', question: 'Which step should change?' }),
    );
    await app.controller().handleMessage(revisionMessage, bot);
    const clarificationMessage = {
      id: '900002',
      author: bot,
      content: clarificationReplies[0]?.content ?? '',
      reference: { messageId: '222' },
      fetchReference: async () => revisionMessage,
    };
    const updatedReplies: MessageCreateOptions[] = [];
    const followup = {
      ...revisionFields,
      id: '333',
      content: 'Include the Windows restart.',
      reference: { messageId: '900002', channelId: '456' },
      fetchReference: async () => clarificationMessage,
      reply: async (payload: MessageCreateOptions) => {
        updatedReplies.push(payload);
        return { id: '900003' };
      },
    } as unknown as Message;
    await app.controller().handleMessage(followup, bot);
    expect(updatedReplies[0]?.content).toContain(`Issue draft: ${id} v2.`);
    expect(updatedReplies[0]?.files ?? []).toHaveLength(0);
    expect(progress.edit).toHaveBeenCalledOnce();
    expect(app.complete).toHaveBeenLastCalledWith(
      expect.stringContaining('"previousDraft":{"repository":"microsoft/aspire"'),
      [],
      expect.any(AbortSignal),
      undefined,
      undefined,
      expect.any(String),
    );
    await app.controller().handleButton(confirmation(id, version).interaction);
    expect(app.create).not.toHaveBeenCalled();
    await app.controller().handleButton(confirmation(id, '2', 'confirm', '900003').interaction);
    expect(app.create).toHaveBeenCalledOnce();
  });

  it.each(
    [policy, { ...policy, allowedChannelIds: [], allowedGuildIds: ['789'] }].flatMap(
      (activePolicy) =>
        (['reply', 'edit'] as const).map((delivery) => ({ activePolicy, delivery })),
    ),
  )(
    'survives restart and publishes the exact preview only once: %j',
    async ({ activePolicy, delivery }) => {
      const app = environment(activePolicy);
      const { preview, id, version, reply, progress } = await requestPreview(
        app.controller(),
        undefined,
        undefined,
        delivery,
      );
      expect(app.create).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(delivery === 'reply' ? 1 : 0);
      expect(progress.edit).toHaveBeenCalledTimes(delivery === 'edit' ? 1 : 0);
      expect(preview.files ?? []).toHaveLength(0);
      const click = confirmation(id, version);
      await app.controller().handleButton(click.interaction);
      expect(app.create).toHaveBeenCalledOnce();
      const [repo, title, body] = app.create.mock.calls[0] ?? [];
      expect(repo).toBe('microsoft/aspire');
      const embed = preview.embeds?.[0];
      const displayed = embed && 'toJSON' in embed ? embed.toJSON() : embed;
      expect(body).toBe(displayed?.description);
      expect(title).toBe(displayed?.title);
      expect(title).toBe('Reported deployment failure');
      expect(body).toContain(`<!-- aspire-discord-issue:${id}:1 -->`);
      expect(click.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'GitHub issue created: https://github.com/microsoft/aspire/issues/42',
        }),
      );
      await app.controller().handleButton(confirmation(id, version).interaction);
      expect(app.create).toHaveBeenCalledOnce();
    },
  );

  it('rejects another authorized requester and a copied button on a different message', async () => {
    const app = environment({ ...policy, allowedUserIds: ['123', '124'] });
    const { id, version } = await requestPreview(app.controller(), undefined, undefined, 'edit');
    const otherRequester = confirmation(id, version);
    Object.defineProperty(otherRequester.interaction, 'user', { value: { id: '124' } });
    await app.controller().handleButton(otherRequester.interaction);
    expect(app.create).not.toHaveBeenCalled();
    const copiedButton = confirmation(id, version, 'confirm', '900099');
    await app.controller().handleButton(copiedButton.interaction);
    expect(app.create).not.toHaveBeenCalled();
    await app.controller().handleButton(confirmation(id, version).interaction);
    expect(app.create).toHaveBeenCalledOnce();
  });

  it('enforces the current policy and expiry when approving an edited preview', async () => {
    const app = environment();
    const { id, version } = await requestPreview(app.controller(), undefined, undefined, 'edit');
    app.setPolicy({ ...policy, allowedUserIds: [] });
    await app.controller().handleButton(confirmation(id, version).interaction);
    expect(app.create).not.toHaveBeenCalled();
    app.setPolicy(policy);
    app.advance(31 * 60_000);
    await app.controller().handleButton(confirmation(id, version).interaction);
    expect(app.create).not.toHaveBeenCalled();
  });

  it('claims an edited preview through ETag only once for concurrent confirmations', async () => {
    const app = environment();
    const { id, version } = await requestPreview(app.controller(), undefined, undefined, 'edit');
    await Promise.all([
      app.controller().handleButton(confirmation(id, version).interaction),
      app.controller().handleButton(confirmation(id, version).interaction),
    ]);
    expect(app.create).toHaveBeenCalledOnce();
  });

  it('reconciles an uncertain GitHub response after restart without resubmitting', async () => {
    const app = environment();
    app.create.mockRejectedValueOnce(new IssuePublishError('GitHub response was lost.', true));
    const { preview, id, version } = await requestPreview(app.controller());
    const first = confirmation(id, version);
    await app.controller().handleButton(first.interaction);
    expect(first.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('not yet confirmed'),
      }),
    );
    await app.controller().handleButton(confirmation(id, version).interaction);
    expect(app.create).toHaveBeenCalledOnce();
    app.advance(31 * 60_000);
    const statusReplies: MessageCreateOptions[] = [];
    const statusMessage = {
      id: '333',
      author: { id: '123', bot: false },
      content: 'check status',
      guildId: '789',
      channelId: '456',
      mentions: { has: () => false },
      reference: { messageId: '900001', channelId: '456' },
      fetchReference: async () => ({ id: '900001', author: bot, content: preview.content }),
      reply: async (payload: MessageCreateOptions) => {
        statusReplies.push(payload);
        return { id: '900004' };
      },
    } as unknown as Message;
    await app.controller().handleMessage(statusMessage, bot);
    expect(statusReplies[0]?.content).toContain('not yet confirmed');
    expect(app.reconcile).toHaveBeenCalledOnce();
    app.reconcile.mockResolvedValueOnce({
      number: 42,
      url: 'https://github.com/microsoft/aspire/issues/42',
    });
    const status = confirmation(id, version, 'status');
    await app.controller().handleButton(status.interaction);
    expect(status.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'GitHub issue created: https://github.com/microsoft/aspire/issues/42',
      }),
    );
    expect(app.create).toHaveBeenCalledOnce();
  });
});
