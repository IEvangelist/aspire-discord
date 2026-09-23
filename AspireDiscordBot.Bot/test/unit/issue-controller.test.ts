import type { ButtonInteraction, Message, MessageCreateOptions, User } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  DiscordIssueController,
  issuePreview,
  type DiscordIssueServices,
} from '../../src/discord/issue-controller.js';
import { IssuePolicyError, type IssueDraft, type IssuePolicy } from '../../src/issues/types.js';
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
    attachPreview: vi.fn<DiscordIssueServices['workflow']['attachPreview']>(async () => ({
      ...initial,
      state: 'awaiting_confirmation',
      previewMessageId: 'preview',
    })),
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
  const reply = vi.fn<(payload: MessageCreateOptions) => Promise<{ id: string }>>(async () => ({
    id: 'preview',
  }));
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
  return { value, reply, fetchReference };
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
        content: expect.stringContaining('Review before publishing'),
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

  it('shows complete outgoing content and audience in the versioned preview', () => {
    const draft = {
      ...initial,
      body: 'x'.repeat(3_500),
      duplicates: [
        { title: 'Existing', number: 1, url: 'https://github.com/microsoft/aspire/issues/1' },
      ],
    };
    const preview = issuePreview(draft);
    expect(preview.content).toContain(`Issue draft: ${initial.id} v1.`);
    expect(JSON.stringify(preview.embeds)).toContain(draft.body);
    expect(JSON.stringify(preview.embeds)).toContain('PUBLIC: visible to everyone');
    expect(preview.files).toHaveLength(1);
    expect(JSON.stringify(preview.components)).toContain(`issue:confirm:${initial.id}:1`);
  });
});
