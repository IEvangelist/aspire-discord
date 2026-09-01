import { EventEmitter } from 'node:events';
import { Events, type Client, type Message, type MessageCreateOptions } from 'discord.js';
import pino, { type Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AnswerService, GroundedAnswer } from '../../src/domain.js';
import { DiscordGateway } from '../../src/discord/gateway.js';
import type { DiscordAttachmentSnapshot } from '../../src/discord/image-context.js';
import type { RuntimeConfig, RuntimeConfigSnapshot } from '../../src/runtime-config.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

interface ClientHarness {
  readonly applicationSet: ReturnType<typeof vi.fn>;
  readonly client: Client;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly guildFetch: ReturnType<typeof vi.fn>;
  readonly guildSet: ReturnType<typeof vi.fn>;
  readonly login: ReturnType<typeof vi.fn>;
  readonly rest: EventEmitter;
}

interface ReplyCall {
  readonly parent: number;
  readonly payload: MessageCreateOptions;
}

interface ReplyChain {
  readonly calls: ReplyCall[];
  readonly nodes: {
    readonly edit: ReturnType<typeof vi.fn>;
    readonly reply: ReturnType<typeof vi.fn>;
  }[];
  readonly root: Message;
}

interface MessageOptions {
  readonly attachments?: readonly DiscordAttachmentSnapshot[];
  readonly authorBot?: boolean;
  readonly content?: string;
  readonly id?: string;
  readonly mentioned?: boolean;
  readonly replyChain?: ReplyChain;
  readonly userId?: string;
}

function createClient(
  options: {
    readonly commandFailure?: Error;
    readonly loginFailure?: Error;
  } = {},
): ClientHarness {
  const emitter = new EventEmitter();
  const applicationSet = vi.fn(async () => {
    if (options.commandFailure) {
      throw options.commandFailure;
    }
  });
  const destroy = vi.fn(async () => undefined);
  const guildSet = vi.fn(async () => undefined);
  const guildFetch = vi.fn(async (id: string) => ({
    commands: { set: guildSet },
    id,
  }));
  const rest = new EventEmitter();
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
    rest,
    user: { id: 'bot', tag: 'Aspirey Bot#5249' },
    ws: { ping: 42 },
  }) as unknown as Client;
  return { applicationSet, client, destroy, guildFetch, guildSet, login, rest };
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

function createReplyChain(): ReplyChain {
  const calls: ReplyCall[] = [];
  const nodes: ReplyChain['nodes'] = [];
  const createNode = (): Message => {
    const index = nodes.length;
    const edit = vi.fn(async () => undefined);
    const reply = vi.fn(async (payload: MessageCreateOptions) => {
      calls.push({ parent: index, payload });
      return createNode();
    });
    nodes.push({ edit, reply });
    return { edit, reply } as unknown as Message;
  };
  return { calls, nodes, root: createNode() };
}

function createMessage(options: MessageOptions = {}) {
  const chain = options.replyChain ?? createReplyChain();
  const attachments = options.attachments ?? [];
  const sendTyping = vi.fn(async () => undefined);
  const reply = vi.fn(async () => chain.root);
  const message = {
    attachments: new Map(attachments.map((attachment) => [attachment.id, attachment])),
    author: { bot: options.authorBot ?? false, id: options.userId ?? 'user' },
    channel: {
      isThread: () => false,
      sendTyping,
    },
    content: options.content ?? '<@bot> How do I add Redis?',
    createdTimestamp: 100,
    channelId: 'channel',
    embeds: [],
    guildId: 'guild',
    id: options.id ?? 'message',
    mentions: { has: () => options.mentioned ?? true },
    reference: null,
    reply,
    system: false,
  } as unknown as Message;
  return { chain, message, reply, sendTyping };
}

function createCapturingLogger(): {
  readonly entries: Record<string, unknown>[];
  readonly logger: Logger;
} {
  const entries: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write(line: string) {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { entries, logger };
}

function createMutableRuntimeConfig(initial: RuntimeConfigSnapshot): {
  readonly runtime: RuntimeConfig;
  set(value: RuntimeConfigSnapshot): void;
} {
  let current = initial;
  return {
    runtime: {
      current: () => current,
      refresh: async () => undefined,
      stop: () => undefined,
    },
    set: (value) => {
      current = value;
    },
  };
}

function attachment(name: string, contentType: string, size: number): DiscordAttachmentSnapshot {
  const image = contentType.startsWith('image/');
  return {
    contentType,
    height: image ? 10 : null,
    id: name,
    name,
    size,
    url: `https://cdn.discordapp.com/attachments/123/456/${name}`,
    width: image ? 10 : null,
  };
}

function emit(client: Client, message: Message): void {
  (client as unknown as EventEmitter).emit(Events.MessageCreate, message);
}

function replyContent(call: ReplyCall): string {
  if (typeof call.payload.content !== 'string') {
    throw new Error('Expected a text reply.');
  }
  return call.payload.content;
}

describe('Discord gateway behavior', () => {
  it('clears global commands, reports readiness, and handles lifecycle events idempotently', async () => {
    const harness = createClient();
    const captured = createCapturingLogger();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      createAnswers().service,
      captured.logger,
      harness.client,
    );

    expect(gateway.status()).toMatchObject({
      access: { allowedUsers: 0, mode: 'open' },
      state: 'offline',
    });
    await gateway.start();
    await gateway.start();
    (harness.client as unknown as EventEmitter).emit(Events.Error, new Error('gateway error'));
    (harness.client as unknown as EventEmitter).emit(
      Events.ShardError,
      new Error('shard error'),
      0,
    );
    (harness.client as unknown as EventEmitter).emit(Events.ShardDisconnect, { code: 1_006 }, 0);
    (harness.client as unknown as EventEmitter).emit(Events.ShardReady, 0, new Set(['guild']));
    (harness.client as unknown as EventEmitter).emit(Events.ShardReconnecting, 0);
    (harness.client as unknown as EventEmitter).emit(Events.ShardResume, 0, 3);
    (harness.client as unknown as EventEmitter).emit(Events.Invalidated);
    (harness.client as unknown as EventEmitter).emit(Events.Warn, 'gateway warning');
    harness.rest.emit('rateLimited', {
      global: false,
      hash: 'hash',
      limit: 5,
      majorParameter: 'channel',
      method: 'POST',
      retryAfter: 1_000,
      route: '/channels/:id/messages',
      scope: 'user',
      sublimitTimeout: 0,
      timeToReset: 1_000,
      url: 'https://discord.com/api/v10/channels/channel/messages',
    });
    harness.rest.emit('invalidRequestWarning', { count: 500, remainingTime: 60_000 });

    expect(harness.applicationSet).toHaveBeenCalledWith([]);
    expect(harness.login).toHaveBeenCalledOnce();
    expect(gateway.ready).toBe(true);
    expect(gateway.status()).toMatchObject({
      botUser: 'Aspirey Bot#5249',
      access: { allowedUsers: 0, mode: 'open' },
      guilds: 1,
      pingMilliseconds: 42,
      state: 'ready',
    });

    await gateway.stop();
    await gateway.stop();
    expect(harness.destroy).toHaveBeenCalledOnce();
    expect(captured.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ closeCode: 1_006, msg: 'Discord shard disconnected.' }),
        expect.objectContaining({ msg: 'Discord shard is ready.', unavailableGuildCount: 1 }),
        expect.objectContaining({ msg: 'Discord shard is reconnecting.' }),
        expect.objectContaining({ msg: 'Discord shard resumed.', replayedEvents: 3 }),
        expect.objectContaining({ msg: 'Discord session was invalidated.' }),
        expect.objectContaining({ msg: 'Discord client warning.', warning: 'gateway warning' }),
        expect.objectContaining({
          msg: 'Discord REST request was rate limited.',
          retryAfterMilliseconds: 1_000,
        }),
        expect.objectContaining({
          invalidRequestCount: 500,
          msg: 'Discord REST invalid-request threshold warning.',
        }),
      ]),
    );
  });

  it('clears legacy guild and global commands when a guild is configured', async () => {
    const harness = createClient();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { guildId: '123', token: 'token' } }),
      createAnswers().service,
      testLogger,
      harness.client,
    );

    await gateway.start();

    expect(harness.applicationSet).toHaveBeenCalledWith([]);
    expect(harness.guildFetch).toHaveBeenCalledWith('123');
    expect(harness.guildSet).toHaveBeenCalledWith([]);
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

  it('reports command cleanup failures separately from login failures', async () => {
    const harness = createClient({ commandFailure: new Error('cleanup failed') });
    const captured = createCapturingLogger();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { token: 'token' } }),
      createAnswers().service,
      captured.logger,
      harness.client,
    );

    await gateway.start();

    expect(harness.login).toHaveBeenCalledOnce();
    expect(harness.destroy).toHaveBeenCalledOnce();
    expect(gateway.ready).toBe(false);
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        msg: 'Discord command cleanup failed after login.',
      }),
    );
    expect(captured.entries).not.toContainEqual(
      expect.objectContaining({
        msg: 'Discord login failed; verify the bot token and privileged intents.',
      }),
    );
  });

  it('publishes the answer and grounded sources as a safe reply chain', async () => {
    const harness = createClient();
    const answers = createAnswers({
      answer: 'Use AddRedis. [1]',
      citations: [
        {
          number: 1,
          repo: 'microsoft/aspire',
          title: 'Redis integration',
          url: 'https://aspire.dev/integrations/caching/redis/',
        },
      ],
    });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const request = createMessage();

    emit(harness.client, request.message);

    await vi.waitFor(() => {
      expect(request.chain.calls).toHaveLength(1);
    });
    expect(request.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [], repliedUser: false },
      }),
    );
    expect(request.chain.nodes[0]?.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Use AddRedis. [1]'),
      }),
    );
    expect(request.chain.nodes[0]?.edit.mock.calls.at(-1)?.[0].content).not.toContain(
      'Grounded sources',
    );
    expect(request.chain.calls[0]).toMatchObject({
      parent: 0,
      payload: {
        allowedMentions: { parse: [], repliedUser: false },
        components: [expect.anything()],
        content: expect.stringContaining('1 grounded source'),
      },
    });
    expect(answers.answer).toHaveBeenCalledWith(
      'How do I add Redis?',
      undefined,
      expect.any(Function),
      expect.objectContaining({ questionSource: 'current' }),
    );
    await gateway.stop();
  });

  it('chains long answer continuations before the grounding reply', async () => {
    const harness = createClient();
    const answers = createAnswers({
      answer: `${'Long grounded guidance. '.repeat(220)} [1]`,
      citations: [
        {
          number: 1,
          repo: 'microsoft/aspire',
          title: 'Aspire guidance',
          url: 'https://aspire.dev/',
        },
      ],
    });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const request = createMessage({ id: 'long-answer' });

    emit(harness.client, request.message);

    await vi.waitFor(() => {
      expect(
        request.chain.calls.some((call) => replyContent(call).includes('grounded source')),
      ).toBe(true);
    });
    const sourceIndex = request.chain.calls.findIndex((call) =>
      replyContent(call).includes('grounded source'),
    );
    expect(sourceIndex).toBeGreaterThan(0);
    expect(request.chain.calls.map((call) => call.parent)).toEqual(
      request.chain.calls.map((_call, index) => index),
    );
    for (const call of request.chain.calls) {
      expect(replyContent(call).length).toBeLessThanOrEqual(2_000);
    }
    await gateway.stop();
  });

  it('ignores ineligible mentions and enforces authorization, deduplication, and rate limits', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const captured = createCapturingLogger();
    const gateway = new DiscordGateway(
      createTestConfig({
        discord: {
          allowedUserIds: new Set(['allowed']),
          maxRequestsPerMinute: 1,
          mentionEnabled: true,
        },
      }),
      answers.service,
      captured.logger,
      harness.client,
    );
    await gateway.start();
    const bot = createMessage({ authorBot: true, id: 'bot' });
    const unmentioned = createMessage({ id: 'unmentioned', mentioned: false });
    const unauthorized = createMessage({ id: 'unauthorized', userId: 'denied' });
    const accepted = createMessage({ id: 'accepted', userId: 'allowed' });
    const limited = createMessage({ id: 'limited', userId: 'allowed' });

    emit(harness.client, bot.message);
    emit(harness.client, unmentioned.message);
    emit(harness.client, unauthorized.message);
    emit(harness.client, accepted.message);
    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalledOnce();
    });
    emit(harness.client, accepted.message);
    emit(harness.client, limited.message);
    await vi.waitFor(() => {
      expect(limited.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('retry in about') }),
      );
    });

    expect(bot.reply).not.toHaveBeenCalled();
    expect(unmentioned.reply).not.toHaveBeenCalled();
    expect(unauthorized.reply).not.toHaveBeenCalled();
    expect(accepted.reply).toHaveBeenCalledOnce();
    expect(gateway.status()).toMatchObject({
      access: { allowedUsers: 1, mode: 'allowlist' },
    });
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        discordChannelId: 'channel',
        discordGuildId: 'guild',
        discordMessageId: 'unauthorized',
        discordUserId: 'denied',
        msg: 'Ignored Discord mention from a user outside the allowlist.',
        outcome: 'not_authorized',
      }),
    );
    expect(JSON.stringify(captured.entries)).not.toContain('How do I add Redis?');
    await gateway.stop();
  });

  it('uses refreshed runtime access and grounding settings without restarting', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const mutable = createMutableRuntimeConfig({
      allowedUserIds: new Set(['first']),
      available: true,
      groundingDetailsMode: 'collapsed',
      revision: 'one',
      source: 'azure-app-configuration',
    });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      harness.client,
      undefined,
      mutable.runtime,
    );
    await gateway.start();
    const first = createMessage({ id: 'first-request', userId: 'first' });

    emit(harness.client, first.message);
    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalledOnce();
    });

    mutable.set({
      allowedUserIds: new Set(['second']),
      available: true,
      groundingDetailsMode: 'hidden',
      revision: 'two',
      source: 'azure-app-configuration',
    });
    const removed = createMessage({ id: 'removed-request', userId: 'first' });
    const second = createMessage({ id: 'second-request', userId: 'second' });
    emit(harness.client, removed.message);
    emit(harness.client, second.message);

    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalledTimes(2);
    });
    expect(removed.reply).not.toHaveBeenCalled();
    expect(gateway.status().access).toEqual({
      allowedUsers: 1,
      configurationReady: true,
      groundingDetailsMode: 'hidden',
      mode: 'allowlist',
      revision: 'two',
      source: 'azure-app-configuration',
    });
    expect(second.chain.calls[0]?.payload.components).toBeUndefined();
    await gateway.stop();
  });

  it('fails closed while remote runtime configuration is unavailable', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const mutable = createMutableRuntimeConfig({
      allowedUserIds: new Set(),
      available: false,
      groundingDetailsMode: 'collapsed',
      revision: 'unavailable',
      source: 'unavailable',
    });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      harness.client,
      undefined,
      mutable.runtime,
    );
    await gateway.start();
    const request = createMessage({ id: 'config-unavailable' });

    emit(harness.client, request.message);

    await vi.waitFor(() => {
      expect(request.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('access configuration is unavailable'),
        }),
      );
    });
    expect(answers.answer).not.toHaveBeenCalled();
    expect(gateway.ready).toBe(false);
    expect(gateway.status().access.mode).toBe('unavailable');
    await gateway.stop();
  });

  it('gives actionable guidance when a bare mention has no surrounding context', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const request = createMessage({ content: '<@bot>', id: 'empty' });

    emit(harness.client, request.message);

    await vi.waitFor(() => {
      expect(request.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Reply to a message') }),
      );
    });
    expect(answers.answer).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('fails closed for oversized direct image and text attachments', async () => {
    const harness = createClient();
    const gateway = new DiscordGateway(
      createTestConfig({
        discord: { mentionEnabled: true },
        imageContext: { enabled: true },
      }),
      createAnswers().service,
      testLogger,
      harness.client,
    );
    await gateway.start();
    const image = createMessage({
      attachments: [attachment('error.png', 'image/png', 4 * 1_024 * 1_024)],
      content: '<@bot>',
      id: 'image',
    });
    const file = createMessage({
      attachments: [attachment('diagnostics.log', 'text/plain', 300 * 1_024)],
      content: '<@bot>',
      id: 'file',
    });

    emit(harness.client, image.message);
    await vi.waitFor(() => {
      expect(image.chain.nodes[0]?.edit).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('too large') }),
      );
    });
    emit(harness.client, file.message);
    await vi.waitFor(() => {
      expect(file.chain.nodes[0]?.edit).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('too large') }),
      );
    });
    await gateway.stop();
  });

  it('returns a generic error without exposing answer-service failures', async () => {
    const harness = createClient();
    const answer = vi.fn<AnswerService['answer']>(async () => {
      throw new Error('private failure');
    });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      { answer },
      testLogger,
      harness.client,
    );
    await gateway.start();
    const request = createMessage({ id: 'failure' });

    emit(harness.client, request.message);

    await vi.waitFor(() => {
      expect(request.chain.nodes[0]?.edit).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Sorry - something went wrong answering that. Please try again.',
        }),
      );
    });
    expect(JSON.stringify(request.chain.nodes[0]?.edit.mock.calls)).not.toContain(
      'private failure',
    );
    await gateway.stop();
  });
});
