import { EventEmitter } from 'node:events';
import {
  Events,
  MessageFlags,
  type Attachment,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AnswerService, GroundedAnswer } from '../../src/domain.js';
import { DiscordGateway } from '../../src/discord/gateway.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

interface ClientHarness {
  readonly applicationSet: ReturnType<typeof vi.fn>;
  readonly client: Client;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly guildFetch: ReturnType<typeof vi.fn>;
  readonly guildSet: ReturnType<typeof vi.fn>;
  readonly login: ReturnType<typeof vi.fn>;
}

function createClient(options: { readonly loginFailure?: Error } = {}): ClientHarness {
  const emitter = new EventEmitter();
  const applicationSet = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const guildSet = vi.fn(async () => undefined);
  const guildFetch = vi.fn(async (id: string) => ({
    commands: { set: guildSet },
    id,
  }));
  let ready = false;
  const login = vi.fn(async () => {
    if (options.loginFailure) {
      throw options.loginFailure;
    }
    ready = true;
    queueMicrotask(() => {
      (client as unknown as EventEmitter).emit(Events.ClientReady, client);
    });
    return 'token';
  });
  const client = Object.assign(emitter, {
    application: { commands: { set: applicationSet } },
    destroy,
    guilds: { cache: new Map([['guild', {}]]), fetch: guildFetch },
    isReady: () => ready,
    login,
    user: { id: 'bot', tag: 'Aspirey Bot#5249' },
    ws: { ping: 42 },
  }) as unknown as Client;
  return { applicationSet, client, destroy, guildFetch, guildSet, login };
}

function createAnswers(result: Partial<GroundedAnswer> = {}) {
  const answer = vi.fn<AnswerService['answer']>(async () => ({
    answer: 'Grounded answer.',
    citations: [],
    isGrounded: true,
    topScore: 0.9,
    ...result,
  }));
  return {
    answer,
    service: { answer } satisfies AnswerService,
  };
}

interface SlashOptions {
  readonly channel?: TextBasedChannel | null;
  readonly commandName?: string;
  readonly file?: Attachment;
  readonly id?: string;
  readonly image?: Attachment;
  readonly question?: string;
  readonly userId?: string;
}

function createSlashInteraction(options: SlashOptions = {}) {
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const reply = vi.fn(async () => undefined);
  const interaction = {
    channel: options.channel ?? null,
    commandName: options.commandName ?? 'ask',
    createdTimestamp: 100,
    deferReply,
    editReply,
    followUp,
    id: options.id ?? 'interaction',
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    options: {
      getAttachment: (name: string) => (name === 'image' ? options.image : options.file) ?? null,
      getString: () => options.question ?? null,
    },
    reply,
    user: { id: options.userId ?? 'user' },
  } as unknown as ChatInputCommandInteraction;
  return { deferReply, editReply, followUp, interaction, reply };
}

function emit(client: Client, event: string, value: unknown): void {
  (client as unknown as EventEmitter).emit(event, value);
}

function attachment(
  name: string,
  contentType: string,
  dimensions: { readonly height: number | null; readonly width: number | null },
): Attachment {
  return {
    contentType,
    height: dimensions.height,
    id: '456',
    name,
    size: 100,
    url: `https://cdn.discordapp.com/attachments/123/456/${name}`,
    width: dimensions.width,
  } as Attachment;
}

describe('Discord gateway behavior', () => {
  it('registers global commands, reports readiness, and handles lifecycle events idempotently', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      testLogger,
      harness.client,
    );

    expect(gateway.status()).toMatchObject({ state: 'offline' });
    await gateway.start();
    await gateway.start();
    emit(harness.client, Events.Error, new Error('gateway error'));
    emit(harness.client, Events.ShardError, new Error('shard error'));

    expect(harness.applicationSet).toHaveBeenCalledOnce();
    expect(harness.applicationSet.mock.calls[0]?.[0]).toHaveLength(2);
    expect(harness.login).toHaveBeenCalledOnce();
    expect(gateway.ready).toBe(true);
    expect(gateway.status()).toMatchObject({
      botUser: 'Aspirey Bot#5249',
      guilds: 1,
      pingMilliseconds: 42,
      state: 'ready',
    });

    await gateway.stop();
    await gateway.stop();
    expect(harness.destroy).toHaveBeenCalledOnce();
  });

  it('registers guild commands when a guild is configured', async () => {
    const harness = createClient();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { guildId: '123', token: 'token' } }),
      createAnswers().service,
      testLogger,
      harness.client,
    );

    await gateway.start();

    expect(harness.guildFetch).toHaveBeenCalledWith('123');
    expect(harness.guildSet).toHaveBeenCalledOnce();
    expect(harness.applicationSet).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('destroys a failed login without claiming readiness', async () => {
    const harness = createClient({ loginFailure: new Error('bad token') });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { token: 'token' } }),
      createAnswers().service,
      testLogger,
      harness.client,
    );

    await gateway.start();

    expect(gateway.ready).toBe(false);
    expect(harness.destroy).toHaveBeenCalledOnce();
  });

  it('handles a slash question, typing, and multi-message output', async () => {
    const harness = createClient();
    const answers = createAnswers({ answer: 'x'.repeat(4_500) });
    const gateway = new DiscordGateway(
      createTestConfig(),
      answers.service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const sendTyping = vi.fn(async () => undefined);
    const channel = {
      isThread: () => false,
      sendTyping,
    } as unknown as TextBasedChannel;
    const slash = createSlashInteraction({
      channel,
      question: 'How do I add Redis to this Aspire app?',
    });

    emit(harness.client, Events.InteractionCreate, slash.interaction);

    await vi.waitFor(() => {
      expect(slash.followUp).toHaveBeenCalled();
    });
    expect(slash.deferReply).toHaveBeenCalledOnce();
    expect(sendTyping).toHaveBeenCalled();
    expect(answers.answer).toHaveBeenCalledWith(
      'How do I add Redis to this Aspire app?',
      expect.any(AbortSignal),
      expect.any(Function),
      expect.objectContaining({ questionSource: 'current' }),
    );
    expect(slash.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [], repliedUser: false },
      }),
    );
    await gateway.stop();
  });

  it('rejects unknown, unauthorized, duplicate, and rate-limited interactions', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(
      createTestConfig({
        discord: {
          allowedUserIds: new Set(['allowed']),
          maxRequestsPerMinute: 1,
        },
      }),
      answers.service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const unknown = createSlashInteraction({
      commandName: 'other',
      id: 'unknown',
      question: 'Ignored',
      userId: 'allowed',
    });
    const unauthorized = createSlashInteraction({
      id: 'unauthorized',
      question: 'Denied',
      userId: 'denied',
    });
    const accepted = createSlashInteraction({
      id: 'accepted',
      question: 'How do I add Redis?',
      userId: 'allowed',
    });
    const limited = createSlashInteraction({
      id: 'limited',
      question: 'How do I add Postgres?',
      userId: 'allowed',
    });

    emit(harness.client, Events.InteractionCreate, unknown.interaction);
    emit(harness.client, Events.InteractionCreate, unauthorized.interaction);
    emit(harness.client, Events.InteractionCreate, accepted.interaction);
    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalledOnce();
    });
    emit(harness.client, Events.InteractionCreate, accepted.interaction);
    emit(harness.client, Events.InteractionCreate, limited.interaction);
    await vi.waitFor(() => {
      expect(limited.reply).toHaveBeenCalled();
    });

    expect(unknown.deferReply).not.toHaveBeenCalled();
    expect(unauthorized.reply).toHaveBeenCalledWith({
      content: 'Sorry - this bot is currently restricted to specific users.',
      flags: MessageFlags.Ephemeral,
    });
    expect(accepted.deferReply).toHaveBeenCalledOnce();
    expect(limited.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('retry in about'),
      flags: MessageFlags.Ephemeral,
    });
    await gateway.stop();
  });

  it('returns actionable slash errors for missing and invalid attachment input', async () => {
    const harness = createClient();
    const gateway = new DiscordGateway(
      createTestConfig(),
      createAnswers().service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const missing = createSlashInteraction({ id: 'missing' });
    const image = createSlashInteraction({
      id: 'image',
      image: attachment('error.png', 'image/png', { height: 10, width: 10 }),
    });
    const file = createSlashInteraction({
      file: attachment('archive.zip', 'application/zip', { height: null, width: null }),
      id: 'file',
    });

    emit(harness.client, Events.InteractionCreate, missing.interaction);
    await vi.waitFor(() => {
      expect(missing.editReply).toHaveBeenCalledWith(
        expect.stringContaining('inside a forum post'),
      );
    });
    emit(harness.client, Events.InteractionCreate, image.interaction);
    await vi.waitFor(() => {
      expect(image.editReply).toHaveBeenCalledWith(expect.stringContaining('not enabled'));
    });
    emit(harness.client, Events.InteractionCreate, file.interaction);
    await vi.waitFor(() => {
      expect(file.editReply).toHaveBeenCalledWith(expect.stringContaining('common UTF-8'));
    });
    await gateway.stop();
  });

  it('returns a generic interaction error without exposing the failure', async () => {
    const harness = createClient();
    const answer = vi.fn<AnswerService['answer']>(async () => {
      throw new Error('private failure');
    });
    const gateway = new DiscordGateway(createTestConfig(), { answer }, testLogger, harness.client);
    await gateway.start();
    const slash = createSlashInteraction({
      question: 'How do I add Redis?',
    });

    emit(harness.client, Events.InteractionCreate, slash.interaction);

    await vi.waitFor(() => {
      expect(slash.editReply).toHaveBeenCalledWith(
        'Sorry - something went wrong answering that. Please try again.',
      );
    });
    expect(JSON.stringify(slash.editReply.mock.calls)).not.toContain('private failure');
    await gateway.stop();
  });

  it('ignores ineligible mentions and gives an actionable response to an empty mention', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const channel = {
      isThread: () => false,
      sendTyping: vi.fn(async () => undefined),
    };
    const reply = vi.fn(async () => ({ edit: vi.fn(async () => undefined) }));
    const messageData = {
      attachments: new Map(),
      author: { bot: false, id: 'user' },
      channel,
      content: '<@bot>',
      createdTimestamp: 100,
      embeds: [],
      id: 'empty',
      mentions: { has: () => true },
      reference: null,
      system: false,
    };
    const empty = { ...messageData, reply } as unknown as Message;
    const botReply = vi.fn();
    const botMessage = {
      ...messageData,
      author: { bot: true, id: 'other-bot' },
      id: 'bot-message',
      reply: botReply,
    } as unknown as Message;
    const unmentionedReply = vi.fn();
    const unmentioned = {
      ...messageData,
      id: 'unmentioned',
      mentions: { has: () => false },
      reply: unmentionedReply,
    } as unknown as Message;

    emit(harness.client, Events.MessageCreate, botMessage);
    emit(harness.client, Events.MessageCreate, unmentioned);
    emit(harness.client, Events.MessageCreate, empty);

    await vi.waitFor(() => {
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('forum post'));
    });
    expect(answers.answer).not.toHaveBeenCalled();
    expect(botReply).not.toHaveBeenCalled();
    expect(unmentionedReply).not.toHaveBeenCalled();
    await gateway.stop();
  });
});
