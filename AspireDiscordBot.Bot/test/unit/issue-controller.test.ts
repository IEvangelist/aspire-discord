import type { ButtonInteraction, Message, MessageCreateOptions, User } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  DiscordIssueController,
  issuePreview,
  type DiscordIssueServices,
  type IssuePreviewMessage,
} from '../../src/discord/issue-controller.js';
import {
  IssueConflictError,
  IssuePolicyError,
  type IssueDraft,
  type IssuePolicy,
} from '../../src/issues/types.js';
import { testLogger } from '../helpers/logger.js';
import type { PreparedIssueFields } from '../../src/domain.js';

const actor = { userId: '123', channelId: '456', guildId: '789' };
const policy: IssuePolicy = {
  enabled: true,
  allowedUserIds: ['123'],
  allowedChannelIds: ['456'],
  allowedRepositories: ['microsoft/aspire'],
};
const bot = { id: '999' } as User;
const initial: IssueDraft = {
  id: '11111111-2222-4333-a444-555555555555',
  version: 1,
  actor,
  repository: 'microsoft/aspire',
  visibility: 'public',
  title: 'Deployment failure',
  body: '## Observed behavior\nA reported failure.',
  marker: '<!-- aspire-discord-issue:test -->',
  contentHash: 'hash',
  sourceMessageIds: ['111'],
  notices: ['Only selected context was read.'],
  duplicates: [],
  createdAt: '2026-09-15T12:00:00Z',
  expiresAt: '2026-09-15T12:30:00Z',
  state: 'draft',
};
const prepared: PreparedIssueFields = {
  repository: initial.repository,
  title: initial.title,
  body: initial.body,
};

function harness(activePolicy: IssuePolicy = policy) {
  const workflow = {
    create: vi.fn<DiscordIssueServices['workflow']['create']>(async () => initial),
    get: vi.fn<DiscordIssueServices['workflow']['get']>(async () => ({
      ...initial,
      state: 'awaiting_confirmation',
      previewMessageId: 'preview',
    })),
    revise: vi.fn<DiscordIssueServices['workflow']['revise']>(async () => ({
      ...initial,
      version: 2,
    })),
    attachPreview: vi.fn<DiscordIssueServices['workflow']['attachPreview']>(
      async (_actor, id, version, previewMessageId) => ({
        ...initial,
        id,
        version,
        state: 'awaiting_confirmation',
        previewMessageId,
      }),
    ),
    confirm: vi.fn<DiscordIssueServices['workflow']['confirm']>(async () => ({
      ...initial,
      state: 'published',
      result: { number: 42, url: 'https://github.com/microsoft/aspire/issues/42' },
    })),
    cancel: vi.fn<DiscordIssueServices['workflow']['cancel']>(async () => ({
      ...initial,
      state: 'cancelled',
    })),
    reconcile: vi.fn<DiscordIssueServices['workflow']['reconcile']>(async () => ({
      ...initial,
      state: 'unknown',
    })),
  };
  const generator = {
    generate: vi.fn<DiscordIssueServices['generator']['generate']>(async () => ({
      repository: initial.repository,
      title: initial.title,
      body: initial.body,
      sourceMessageIds: initial.sourceMessageIds,
      notices: initial.notices,
    })),
  };
  const controller = new DiscordIssueController(
    { workflow, generator },
    () => activePolicy,
    testLogger,
  );
  return { controller, workflow, generator };
}

let messageSequence = 110;
function message(
  content: string,
  options: { replyToPreview?: boolean; userId?: string; mention?: boolean } = {},
) {
  const preview = existingPreview('preview');
  const reply = vi.fn<(payload: MessageCreateOptions) => Promise<IssuePreviewMessage>>(
    async () => preview,
  );
  const fetchReference = vi.fn(async () => ({
    id: 'preview',
    author: bot,
    content: `Issue draft: ${initial.id} v1.`,
  }));
  const value = {
    id: String(++messageSequence),
    author: { id: options.userId ?? actor.userId, bot: false },
    guildId: actor.guildId,
    channelId: actor.channelId,
    content,
    createdTimestamp: Date.now(),
    channel: { isThread: () => false },
    mentions: { has: () => options.mention ?? true },
    reference: options.replyToPreview ? { messageId: 'preview', channelId: actor.channelId } : null,
    reply,
    fetchReference,
  } as unknown as Message;
  return { value, reply, fetchReference, preview };
}

function existingPreview(id = '900001') {
  return { id, edit: vi.fn<IssuePreviewMessage['edit']>(async () => undefined) };
}

function firstEmbed(preview: MessageCreateOptions) {
  const embed = preview.embeds?.[0];
  if (!embed) throw new Error('The complete preview embed was expected.');
  return 'toJSON' in embed ? embed.toJSON() : embed;
}

function button(action = 'confirm', userId = actor.userId) {
  const value = {
    customId: `issue:${action}:${initial.id}:1`,
    user: { id: userId },
    guildId: actor.guildId,
    channelId: actor.channelId,
    message: { id: 'preview', edit: vi.fn(async () => undefined) },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return { value, interaction: value as unknown as ButtonInteraction };
}

describe('Discord issue workflow', () => {
  it('preserves the model-prepared Testing title and 1.2.3 body on a bare repository answer', async () => {
    const { controller, workflow, generator } = harness({
      ...policy,
      allowedChannelIds: [],
      allowedGuildIds: [actor.guildId],
    });
    const request = message('aspire.dev', { mention: false });
    const input = { repository: 'microsoft/aspire', title: 'Testing', body: '1.2.3' };
    workflow.create.mockResolvedValueOnce({ ...initial, ...input });
    expect(await controller.prepareDraft(request.value, bot, input)).toEqual({
      draftId: initial.id,
      version: 1,
    });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(workflow.create).toHaveBeenCalledWith(
      actor,
      {
        ...input,
        sourceMessageIds: [request.value.id],
        notices: expect.any(Array),
      },
      expect.any(AbortSignal),
    );
    expect(workflow.create).toHaveBeenCalledOnce();
    expect(workflow.attachPreview).toHaveBeenCalledOnce();
    expect(workflow.confirm).not.toHaveBeenCalled();
    expect(request.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Issue draft:') }),
    );
    expect(JSON.stringify(request.reply.mock.calls[0]?.[0].embeds)).toContain('"title":"Testing"');
    expect(JSON.stringify(request.reply.mock.calls[0]?.[0].embeds)).toContain(
      '"description":"1.2.3"',
    );
  });
  it('uses server-wide scope for new drafts, non-mention replies and buttons', async () => {
    const { controller, workflow } = harness({
      ...policy,
      allowedChannelIds: [],
      allowedGuildIds: [actor.guildId],
    });
    const request = message('File an issue');
    await controller.prepareDraft(request.value, bot, prepared);
    expect(workflow.create).toHaveBeenCalledOnce();
    const revision = message('Add the reproduction detail', {
      replyToPreview: true,
      mention: false,
    });
    expect(await controller.handleMessage(revision.value, bot)).toBe(true);
    expect(workflow.revise).toHaveBeenCalledOnce();
    await controller.handleButton(button().interaction);
    expect(workflow.confirm).toHaveBeenCalledOnce();
  });
  it('rejects other servers and DMs even for an approved user in server-wide mode', async () => {
    for (const guildId of [null, 'unapproved']) {
      const { controller, workflow, generator } = harness({
        ...policy,
        allowedChannelIds: [],
        allowedGuildIds: [actor.guildId],
      });
      const request = message('File an issue');
      Object.defineProperty(request.value, 'guildId', { value: guildId });
      await expect(controller.prepareDraft(request.value, bot, prepared)).rejects.toThrow(
        IssuePolicyError,
      );
      expect(workflow.create).not.toHaveBeenCalled();
      expect(generator.generate).not.toHaveBeenCalled();
      const click = button();
      Object.defineProperty(click.value, 'guildId', { value: guildId });
      await controller.handleButton(click.interaction);
      expect(workflow.confirm).not.toHaveBeenCalled();
    }
  });
  it('rejects disabled-policy drafting without reporting success or sending a preview', async () => {
    const controller = new DiscordIssueController(
      undefined,
      () => ({ ...policy, enabled: false }),
      testLogger,
    );
    const first = message('File an issue');
    await expect(controller.prepareDraft(first.value, bot, prepared)).rejects.toThrow('disabled');
    expect(first.reply).not.toHaveBeenCalled();
  });

  it('suppresses duplicate tool calls and rate-limits new draft requests', async () => {
    const { controller, workflow, generator } = harness();
    const first = message('aspire.dev', { mention: false });
    await controller.prepareDraft(first.value, bot, prepared);
    await expect(controller.prepareDraft(first.value, bot, prepared)).rejects.toThrow(
      'already been processed',
    );
    expect(workflow.create).toHaveBeenCalledOnce();
    expect(first.reply).toHaveBeenCalledOnce();
    for (let index = 0; index < 5; index++) {
      await controller.prepareDraft(message('aspire.dev').value, bot, prepared);
    }
    await expect(
      controller.prepareDraft(message('aspire.dev').value, bot, prepared),
    ).rejects.toThrow('Too many issue requests');
    expect(workflow.create).toHaveBeenCalledTimes(6);
    expect(workflow.confirm).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('uses the current policy when preparing a draft', async () => {
    const getPolicy = vi.fn(() => policy);
    const { workflow, generator } = harness();
    const controller = new DiscordIssueController({ workflow, generator }, getPolicy, testLogger);
    await controller.prepareDraft(message('aspire.dev').value, bot, prepared);
    getPolicy.mockReturnValue({ ...policy, allowedUserIds: [] });
    await expect(
      controller.prepareDraft(message('aspire.dev').value, bot, prepared),
    ).rejects.toThrow('not authorized');
    expect(workflow.create).toHaveBeenCalledOnce();
  });

  it('does not read cross-channel context or accept a bot as the requester', async () => {
    const { controller, workflow } = harness();
    const crossChannel = message('aspire.dev', { replyToPreview: true });
    Object.defineProperty(crossChannel.value, 'reference', {
      value: { messageId: 'preview', channelId: 'another-channel' },
    });
    await expect(controller.prepareDraft(crossChannel.value, bot, prepared)).rejects.toThrow(
      'Cross-channel',
    );
    expect(crossChannel.fetchReference).not.toHaveBeenCalled();
    const automated = message('aspire.dev');
    Object.defineProperty(automated.value, 'author', {
      value: { id: actor.userId, bot: true },
    });
    await expect(controller.prepareDraft(automated.value, bot, prepared)).rejects.toThrow(
      'human requester',
    );
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it.each(['create', 'attachPreview'] as const)(
    'propagates %s failures instead of reporting a successful tool result',
    async (operation) => {
      const { controller, workflow } = harness();
      workflow[operation].mockRejectedValueOnce(new IssuePolicyError('Draft action rejected.'));
      await expect(
        controller.prepareDraft(message('aspire.dev').value, bot, prepared),
      ).rejects.toThrow('Draft action rejected');
      expect(workflow.confirm).not.toHaveBeenCalled();
    },
  );

  it('does not report success when preview delivery fails', async () => {
    const { controller, workflow } = harness();
    const request = message('aspire.dev');
    request.reply.mockRejectedValueOnce(new Error('Discord unavailable'));
    await expect(controller.prepareDraft(request.value, bot, prepared)).rejects.toThrow(
      'Discord unavailable',
    );
    expect(workflow.attachPreview).not.toHaveBeenCalled();
    expect(workflow.confirm).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: 'not-the-original-preview' }])(
    'edits the existing server-provided preview and binds its exact ID, ignoring edit result %j',
    async (editResult) => {
      const { controller, workflow } = harness();
      const request = message('aspire.dev');
      const preview = existingPreview();
      preview.edit.mockResolvedValueOnce(editResult);
      await expect(
        controller.prepareDraft(request.value, bot, prepared, undefined, preview),
      ).resolves.toEqual({ draftId: initial.id, version: initial.version });
      expect(request.reply).not.toHaveBeenCalled();
      expect(preview.edit).toHaveBeenCalledExactlyOnceWith(issuePreview(initial));
      expect(workflow.attachPreview).toHaveBeenCalledExactlyOnceWith(
        actor,
        initial.id,
        initial.version,
        preview.id,
        expect.any(AbortSignal),
      );
      expect(workflow.attachPreview.mock.invocationCallOrder[0]).toBeGreaterThan(
        preview.edit.mock.invocationCallOrder[0] ?? 0,
      );
      expect(workflow.create).toHaveBeenCalledOnce();
      expect(workflow.confirm).not.toHaveBeenCalled();
    },
  );

  it('does not return a receipt until delivery and attachment have both completed', async () => {
    const { controller, workflow } = harness();
    const preview = existingPreview();
    const delivery = Promise.withResolvers<unknown>();
    const attachment = Promise.withResolvers<IssueDraft>();
    preview.edit.mockReturnValueOnce(delivery.promise);
    workflow.attachPreview.mockReturnValueOnce(attachment.promise);
    const received = vi.fn();
    const preparedDraft = controller
      .prepareDraft(message('aspire.dev').value, bot, prepared, undefined, preview)
      .then(received);
    await vi.waitFor(() => expect(preview.edit).toHaveBeenCalledOnce());
    expect(workflow.attachPreview).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    delivery.resolve(undefined);
    await vi.waitFor(() => expect(workflow.attachPreview).toHaveBeenCalledOnce());
    expect(received).not.toHaveBeenCalled();
    attachment.resolve({
      ...initial,
      state: 'awaiting_confirmation',
      previewMessageId: preview.id,
    });
    await preparedDraft;
    expect(received).toHaveBeenCalledExactlyOnceWith({ draftId: initial.id, version: 1 });
  });

  it.each(['', '  '])(
    'rejects empty preview ID %j before creating or delivering a draft',
    async (id) => {
      const { controller, workflow } = harness();
      const request = message('aspire.dev');
      const preview = existingPreview(id);
      await expect(
        controller.prepareDraft(request.value, bot, prepared, undefined, preview),
      ).rejects.toThrow('identifier');
      expect(workflow.create).not.toHaveBeenCalled();
      expect(workflow.attachPreview).not.toHaveBeenCalled();
      expect(preview.edit).not.toHaveBeenCalled();
      expect(request.reply).not.toHaveBeenCalled();
    },
  );

  it('rejects an undelivered edit without attaching or retrying creation', async () => {
    const { controller, workflow } = harness();
    const request = message('aspire.dev');
    const preview = existingPreview();
    const error = new Error('Discord edit unavailable');
    preview.edit.mockRejectedValueOnce(error);
    await expect(
      controller.prepareDraft(request.value, bot, prepared, undefined, preview),
    ).rejects.toBe(error);
    expect(workflow.create).toHaveBeenCalledOnce();
    expect(workflow.attachPreview).not.toHaveBeenCalled();
    expect(workflow.confirm).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
    expect(preview.edit).toHaveBeenLastCalledWith({ components: [] });
  });

  it.each([false, true])(
    'preserves attachment errors and removes exact-preview controls best-effort (cleanup fails: %j)',
    async (cleanupFails) => {
      const { controller, workflow } = harness();
      const request = message('aspire.dev');
      const preview = existingPreview();
      const failure = new Error('Private storage response was lost.');
      const log = vi.spyOn(testLogger, 'warn');
      workflow.attachPreview.mockRejectedValueOnce(failure);
      if (cleanupFails) {
        preview.edit
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('Private Discord cleanup details.'));
      }
      await expect(
        controller.prepareDraft(request.value, bot, prepared, undefined, preview),
      ).rejects.toBe(failure);
      expect(preview.edit).toHaveBeenCalledTimes(2);
      expect(preview.edit).toHaveBeenNthCalledWith(1, issuePreview(initial));
      expect(preview.edit).toHaveBeenLastCalledWith({ components: [] });
      expect(workflow.attachPreview).toHaveBeenCalledExactlyOnceWith(
        actor,
        initial.id,
        1,
        preview.id,
        expect.any(AbortSignal),
      );
      expect(request.reply).not.toHaveBeenCalled();
      expect(workflow.confirm).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        { errorType: 'Error', outcome: 'failed' },
        'Discord issue action did not complete.',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('Private');
      await expect(
        controller.prepareDraft(request.value, bot, prepared, undefined, preview),
      ).rejects.toThrow('already been processed');
      expect(workflow.create).toHaveBeenCalledOnce();
    },
  );

  it('also removes controls when attaching a newly replied preview fails', async () => {
    const { controller, workflow } = harness();
    const request = message('aspire.dev');
    const failure = new IssueConflictError();
    workflow.attachPreview.mockRejectedValueOnce(failure);
    await expect(controller.prepareDraft(request.value, bot, prepared)).rejects.toBe(failure);
    expect(request.preview.edit).toHaveBeenCalledExactlyOnceWith({ components: [] });
    expect(request.reply).toHaveBeenCalledOnce();
    expect(workflow.create).toHaveBeenCalledOnce();
  });

  it.each([
    { state: 'unknown' as const },
    { id: 'another-draft' },
    { version: 2 },
    { previewMessageId: 'another-preview' },
  ])('rejects an attachment receipt with mismatched state or binding: %j', async (mismatch) => {
    const { controller, workflow } = harness();
    const request = message('aspire.dev');
    const preview = existingPreview();
    workflow.attachPreview.mockResolvedValueOnce({
      ...initial,
      state: 'awaiting_confirmation',
      previewMessageId: preview.id,
      ...mismatch,
    });
    await expect(
      controller.prepareDraft(request.value, bot, prepared, undefined, preview),
    ).rejects.toBeInstanceOf(IssueConflictError);
    expect(preview.edit).toHaveBeenLastCalledWith({ components: [] });
    expect(workflow.create).toHaveBeenCalledOnce();
    expect(workflow.confirm).not.toHaveBeenCalled();
  });

  it('does not claim preparation success for a non-draft workflow result', async () => {
    const { controller, workflow } = harness();
    const request = message('aspire.dev');
    const preview = existingPreview();
    workflow.create.mockResolvedValueOnce({ ...initial, state: 'unknown' });
    await expect(
      controller.prepareDraft(request.value, bot, prepared, undefined, preview),
    ).rejects.toBeInstanceOf(IssueConflictError);
    expect(workflow.attachPreview).not.toHaveBeenCalled();
    expect(preview.edit).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
  });

  it('rejects pre-cancelled work before workflow calls or preview delivery', async () => {
    const { controller, workflow, generator } = harness();
    const request = message('aspire.dev', { replyToPreview: true });
    const preview = existingPreview();
    const failure = new Error('Request cancelled.');
    await expect(
      controller.prepareDraft(request.value, bot, prepared, AbortSignal.abort(failure), preview),
    ).rejects.toBe(failure);
    expect(workflow.create).not.toHaveBeenCalled();
    expect(workflow.attachPreview).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
    expect(request.fetchReference).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
    expect(preview.edit).not.toHaveBeenCalled();
  });

  it('checks cancellation immediately before editing the progress preview', async () => {
    const { controller, workflow } = harness();
    const request = message('aspire.dev');
    const preview = existingPreview();
    const abort = new AbortController();
    const failure = new Error('Cancelled after creating the draft.');
    workflow.create.mockImplementationOnce(async () => {
      abort.abort(failure);
      return initial;
    });
    await expect(
      controller.prepareDraft(request.value, bot, prepared, abort.signal, preview),
    ).rejects.toBe(failure);
    expect(workflow.create).toHaveBeenCalledOnce();
    expect(workflow.attachPreview).not.toHaveBeenCalled();
    expect(preview.edit).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
  });

  it.each(['edit', 'attach'] as const)(
    'propagates cancellation during %s and removes delivered controls',
    async (phase) => {
      const { controller, workflow } = harness();
      const request = message('aspire.dev');
      const preview = existingPreview();
      const abort = new AbortController();
      const failure = new Error('Request cancelled.');
      if (phase === 'edit') {
        preview.edit.mockImplementationOnce(async () => {
          abort.abort(failure);
        });
      } else {
        workflow.attachPreview.mockImplementationOnce(
          async (_actor, _id, _version, _previewId, signal) => {
            abort.abort(failure);
            signal?.throwIfAborted();
            return initial;
          },
        );
      }
      await expect(
        controller.prepareDraft(request.value, bot, prepared, abort.signal, preview),
      ).rejects.toBe(failure);
      expect(preview.edit).toHaveBeenCalledTimes(2);
      expect(preview.edit).toHaveBeenLastCalledWith({ components: [] });
      expect(workflow.attachPreview).toHaveBeenCalledTimes(phase === 'attach' ? 1 : 0);
      expect(workflow.create).toHaveBeenCalledOnce();
      expect(workflow.confirm).not.toHaveBeenCalled();
      expect(request.reply).not.toHaveBeenCalled();
    },
  );

  it('resumes a requester-owned legacy clarification reply after restart', async () => {
    const { controller, generator, workflow } = harness();
    const first = message('File an issue about the deployment failure');
    const followup = message('microsoft/aspire', { mention: false, replyToPreview: true });
    const clarificationMessage = {
      id: 'clarification',
      author: bot,
      content: 'Which repository?\n[Issue drafting clarification]',
      reference: { messageId: '111' },
      fetchReference: async () => first.value,
    };
    followup.fetchReference.mockResolvedValue(clarificationMessage);
    expect(await controller.handleMessage(followup.value, bot)).toBe(true);
    expect(generator.generate).toHaveBeenLastCalledWith(
      expect.stringContaining('Earlier request: File an issue about the deployment failure'),
      expect.any(Object),
      policy.allowedRepositories,
      undefined,
      expect.any(AbortSignal),
    );
    expect(workflow.create).toHaveBeenCalledOnce();
    expect(workflow.confirm).not.toHaveBeenCalled();
  });

  it('binds prepared fields for approval only after preview delivery', async () => {
    const { controller, workflow, generator } = harness();
    const request = message('<@999> Please file an issue about this deployment failure.');
    await controller.prepareDraft(request.value, bot, prepared);
    expect(generator.generate).not.toHaveBeenCalled();
    expect(workflow.create).toHaveBeenCalledOnce();
    expect(workflow.confirm).not.toHaveBeenCalled();
    expect(workflow.attachPreview).toHaveBeenCalledWith(
      actor,
      initial.id,
      1,
      'preview',
      expect.any(AbortSignal),
    );
    expect(request.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(`Review this draft for ${initial.repository}`),
        allowedMentions: { parse: [], repliedUser: false },
      }),
    );
    expect(workflow.attachPreview.mock.invocationCallOrder[0]).toBeGreaterThan(
      request.reply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each(['<@999> How do I use Redis?', '<@999> create a test issue', 'create the issue'])(
    'leaves every non-reply on the model answer path: %s',
    async (content) => {
      const { controller, workflow, generator } = harness();
      const request = message(content);
      expect(await controller.handleMessage(request.value, bot)).toBe(false);
      expect(workflow.create).not.toHaveBeenCalled();
      expect(generator.generate).not.toHaveBeenCalled();
    },
  );

  it('handles revisions by reply without requiring another mention', async () => {
    const { controller, workflow } = harness();
    const request = message('Add that this occurs on Windows.', {
      replyToPreview: true,
      mention: false,
    });
    expect(await controller.handleMessage(request.value, bot)).toBe(true);
    expect(workflow.revise).toHaveBeenCalledWith(
      actor,
      initial.id,
      1,
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(workflow.confirm).not.toHaveBeenCalled();
    expect(workflow.attachPreview).toHaveBeenCalledWith(
      actor,
      initial.id,
      2,
      'preview',
      expect.any(AbortSignal),
    );
    expect(request.reply).toHaveBeenCalledOnce();
    expect(request.preview.edit).not.toHaveBeenCalled();
  });

  it('requires an explicit confirmation tied to the exact preview', async () => {
    const { controller, workflow, generator } = harness();
    await controller.handleMessage(
      message('yes', { replyToPreview: true, mention: false }).value,
      bot,
    );
    expect(workflow.confirm).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
    await controller.handleMessage(
      message('create the issue', { replyToPreview: true, mention: false }).value,
      bot,
    );
    expect(workflow.confirm).toHaveBeenCalledWith(
      actor,
      initial.id,
      1,
      'preview',
      expect.any(AbortSignal),
    );
  });

  it('rejects unauthorized callers without reading their references or generating a draft', async () => {
    const { controller, workflow, generator } = harness();
    const request = message('File an issue', { userId: '666', replyToPreview: true });
    expect(await controller.handleMessage(request.value, bot)).toBe(false);
    await expect(controller.prepareDraft(request.value, bot, prepared)).rejects.toThrow(
      'not authorized',
    );
    expect(request.fetchReference).not.toHaveBeenCalled();
    expect(workflow.create).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
  });

  it('publishes through an authenticated button and returns the GitHub URL', async () => {
    const { controller, workflow } = harness();
    const interaction = button();
    await controller.handleButton(interaction.interaction);
    expect(workflow.confirm).toHaveBeenCalledWith(
      actor,
      initial.id,
      1,
      'preview',
      expect.any(AbortSignal),
    );
    expect(interaction.value.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'GitHub issue created: https://github.com/microsoft/aspire/issues/42',
      }),
    );
  });

  it('does not re-submit when a success notification fails', async () => {
    const { controller, workflow } = harness();
    const interaction = button();
    interaction.value.editReply.mockRejectedValueOnce(new Error('Discord unavailable'));
    await controller.handleButton(interaction.interaction);
    expect(workflow.confirm).toHaveBeenCalledOnce();
    expect(interaction.value.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Check status'),
      }),
    );
  });

  it('rejects someone else clicking the controls', async () => {
    const { controller, workflow } = harness();
    const interaction = button('confirm', '666');
    await controller.handleButton(interaction.interaction);
    expect(workflow.confirm).not.toHaveBeenCalled();
    expect(interaction.value.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('not authorized'),
      }),
    );
  });

  it('reports unconfigured or disabled filing rather than pretending to create an issue', async () => {
    const controller = new DiscordIssueController(undefined, () => policy, testLogger);
    const request = message('File an issue');
    await expect(controller.prepareDraft(request.value, bot, prepared)).rejects.toThrow(
      'Key Vault signing key',
    );
    expect(request.reply).not.toHaveBeenCalled();
    expect(controller.status()).toEqual({ configured: false, enabled: true });
  });

  it.each(['public', 'private'] as const)(
    'shows the complete outgoing title/body once, without an attachment, for a %s repository',
    (visibility) => {
      const draft = {
        ...initial,
        visibility,
        title: 'T'.repeat(180),
        body: `${'x'.repeat(3_500 - initial.marker.length - 2)}\n\n${initial.marker}`,
        duplicates: [
          { title: 'Existing', number: 1, url: 'https://github.com/microsoft/aspire/issues/1' },
        ],
      };
      const before = structuredClone(draft);
      const preview = issuePreview(draft);
      const embed = firstEmbed(preview);
      expect(preview.content).toContain(`Issue draft: ${initial.id} v1.`);
      expect(preview.content?.length).toBeLessThanOrEqual(600);
      expect(preview.content).toContain('Nothing posted yet.');
      expect(preview.content).toContain('may notify subscribers');
      expect(preview.content).toContain('Review for sensitive information');
      expect(preview.content).toContain('Only the requester');
      expect(preview.content).toContain('**Create issue**');
      expect(preview.content).toContain('"create the issue"');
      expect(preview.content).toContain('A plain "yes" does not publish.');
      expect(preview.content).not.toContain(draft.body);
      expect(preview.content).not.toContain(initial.notices[0]);
      expect(preview.files ?? []).toHaveLength(0);
      expect(preview.embeds).toHaveLength(1);
      expect(embed.title).toBe(draft.title);
      expect(embed.description).toBe(draft.body);
      expect(embed.description).toHaveLength(3_500);
      expect(embed.description).toContain(initial.marker);
      expect(embed.footer?.text).toBe(`Version 1 | Expires ${initial.expiresAt}`);
      expect(embed.fields).toContainEqual({
        name: 'Repository and audience',
        value: `${initial.repository}\n${visibility === 'public' ? 'PUBLIC: visible to everyone' : 'PRIVATE: visible to people with repository access'}`,
      });
      expect(embed.fields).toContainEqual({
        name: 'Possible existing issues - review before filing',
        value: '#1: https://github.com/microsoft/aspire/issues/1',
      });
      expect(embed.fields).toContainEqual({
        name: 'Context and limitations',
        value: initial.notices[0],
      });
      if (visibility === 'private') {
        expect(preview.content).not.toMatch(/\bpublic\b/iu);
      } else {
        expect(preview.content).toContain('title/body public');
      }
      for (const action of ['confirm', 'cancel', 'status']) {
        expect(JSON.stringify(preview.components)).toContain(`issue:${action}:${initial.id}:1`);
      }
      expect(preview.allowedMentions).toEqual({ parse: [], repliedUser: false });
      expect(draft).toEqual(before);
    },
  );

  it('bounds context limitations separately from the concise caption and full issue body', () => {
    const notices = ['First', 'Second', 'Third', 'Fourth', 'Fifth'].map(
      (prefix) => `${prefix}: ${'context '.repeat(60)}`,
    );
    const preview = issuePreview({
      ...initial,
      notices,
      duplicates: Array.from({ length: 6 }, (_, index) => ({
        title: 'Existing',
        number: index + 1,
        url: `https://github.com/microsoft/aspire/issues/${String(index + 1)}?${'a'.repeat(400)}`,
      })),
    });
    const embed = firstEmbed(preview);
    const context = embed.fields?.find((field) => field.name === 'Context and limitations');
    expect(context?.value.length).toBeLessThanOrEqual(1_024);
    expect(context?.value.split('\n').slice(0, 3)).toEqual(
      notices.slice(0, 3).map((notice) => `${notice.slice(0, 249)}…`),
    );
    expect(context?.value).toContain('2 additional context notice(s).');
    expect(
      embed.fields?.find((field) => field.name.startsWith('Possible existing'))?.value.length,
    ).toBeLessThanOrEqual(1_024);
    expect(preview.content?.length).toBeLessThanOrEqual(600);
    expect(preview.content).not.toContain('First:');
    expect(preview.content).toContain(`Issue draft: ${initial.id} v1.`);
    expect(embed.description).toBe(initial.body);
  });

  it('omits the limitations field when there are no context notices', () => {
    const preview = issuePreview({ ...initial, notices: [] });
    expect(firstEmbed(preview).fields?.map((field) => field.name)).toEqual([
      'Repository and audience',
    ]);
  });
});
