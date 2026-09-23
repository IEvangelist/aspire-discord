import type { ButtonInteraction, Message, MessageCreateOptions, User } from 'discord.js';
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
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function requestPreview(controller: DiscordIssueController) {
  const replies: MessageCreateOptions[] = [];
  const message = {
    id: '111',
    author: { id: '123', bot: false },
    content: '<@999> Please file an issue about a deployment failure.',
    guildId: '789',
    channelId: '456',
    createdTimestamp: Date.now(),
    channel: { isThread: () => false },
    mentions: { has: () => true },
    reference: null,
    reply: async (payload: MessageCreateOptions) => {
      replies.push(payload);
      return { id: '900001' };
    },
  } as unknown as Message;
  await controller.handleMessage(message, bot);
  const preview = replies[0];
  const match = /Issue draft: ([a-f0-9-]{36}) v(\d+)\./u.exec(preview?.content ?? '');
  if (!preview || !match?.[1] || !match[2]) {
    throw new Error(`A complete draft preview was expected: ${String(preview?.content)}`);
  }
  return { preview, id: match[1], version: match[2] };
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
  it('keeps revision identity and invalidates the old preview after a clarification', async () => {
    const app = environment();
    const { preview, id, version } = await requestPreview(app.controller());
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

  it.each([policy, { ...policy, allowedChannelIds: [], allowedGuildIds: ['789'] }])(
    'survives restart and publishes the exact preview only once under policy %j',
    async (activePolicy) => {
      const app = environment(activePolicy);
      const { preview, id, version } = await requestPreview(app.controller());
      expect(app.create).not.toHaveBeenCalled();
      const click = confirmation(id, version);
      await app.controller().handleButton(click.interaction);
      expect(app.create).toHaveBeenCalledOnce();
      const [repo, title, body] = app.create.mock.calls[0] ?? [];
      expect(repo).toBe('microsoft/aspire');
      expect(JSON.stringify(preview.embeds)).toContain(JSON.stringify(body).slice(1, -1));
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
