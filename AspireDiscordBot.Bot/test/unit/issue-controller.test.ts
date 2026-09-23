import type { ButtonInteraction, Message, MessageCreateOptions, User } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  DiscordIssueController,
  issuePreview,
  type DiscordIssueServices,
} from '../../src/discord/issue-controller.js';
import type { IssueDraft, IssuePolicy } from '../../src/issues/types.js';
import { testLogger } from '../helpers/logger.js';
import { IssueClarificationError } from '../../src/issues/drafting.js';

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

function harness() {
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
  const controller = new DiscordIssueController({ workflow, generator }, () => policy, testLogger);
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
  it('deduplicates requests and bounds disabled-policy rejection replies', async () => {
    const controller = new DiscordIssueController(
      undefined,
      () => ({ ...policy, enabled: false }),
      testLogger,
    );
    const first = message('File an issue');
    await controller.handleMessage(first.value, bot);
    await controller.handleMessage(first.value, bot);
    expect(first.reply).toHaveBeenCalledOnce();
    const remaining = Array.from({ length: 7 }, () => message('File an issue'));
    for (const request of remaining) await controller.handleMessage(request.value, bot);
    expect(remaining.reduce((count, request) => count + request.reply.mock.calls.length, 0)).toBe(
      5,
    );
  });
  it('asks for missing details and resumes a requester-owned clarification reply', async () => {
    const { controller, generator, workflow } = harness();
    generator.generate.mockRejectedValueOnce(new IssueClarificationError('Which repository?'));
    const first = message('File an issue about the deployment failure');
    await controller.handleMessage(first.value, bot);
    const clarificationContent = first.reply.mock.calls[0]?.[0].content;
    expect(clarificationContent).toContain('[Issue drafting clarification]');
    const followup = message('microsoft/aspire', { mention: false, replyToPreview: true });
    const clarificationMessage = {
      id: 'clarification',
      author: bot,
      content: clarificationContent ?? '',
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

  it('drafts a natural-language request and binds approval only after preview delivery', async () => {
    const { controller, workflow, generator } = harness();
    const request = message('<@999> Please file an issue about this deployment failure.');
    expect(await controller.handleMessage(request.value, bot)).toBe(true);
    expect(generator.generate).toHaveBeenCalledOnce();
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

  it('leaves ordinary questions on the existing answer path', async () => {
    const { controller, workflow, generator } = harness();
    const request = message('<@999> How do I use Redis?');
    expect(await controller.handleMessage(request.value, bot)).toBe(false);
    expect(workflow.create).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
  });

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
    expect(await controller.handleMessage(request.value, bot)).toBe(true);
    expect(request.fetchReference).not.toHaveBeenCalled();
    expect(workflow.create).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
    expect(request.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not authorized') }),
    );
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
    await controller.handleMessage(request.value, bot);
    expect(request.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Key Vault signing key') }),
    );
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
