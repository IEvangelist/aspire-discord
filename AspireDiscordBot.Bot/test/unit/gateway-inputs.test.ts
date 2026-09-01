import { EventEmitter } from 'node:events';
import {
  Events,
  MessageReferenceType,
  type Client,
  type Message,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AnswerService } from '../../src/domain.js';
import { DiscordGateway } from '../../src/discord/gateway.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

function createClient(): Client {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    destroy: vi.fn(async () => undefined),
    guilds: { cache: new Map() },
    isReady: () => false,
    user: { id: 'bot', tag: 'Aspirey Bot#5249' },
    ws: { ping: 0 },
  }) as unknown as Client;
}

function createAnswers() {
  const answer = vi.fn<AnswerService['answer']>(async () => ({
    answer: 'Grounded answer.',
    citations: [],
    isGrounded: true,
    topScore: 0.9,
  }));
  return {
    answer,
    service: { answer } satisfies AnswerService,
  };
}

function responseMessage() {
  return {
    edit: vi.fn(async () => undefined),
  };
}

describe('Discord gateway input adapters', () => {
  it('routes a real-shaped forward snapshot without trying to fetch it as a reply', async () => {
    const client = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      client,
    );
    await gateway.start();
    const fetchReference = vi.fn(async () => {
      throw new Error('forward source is intentionally inaccessible');
    });
    const reply = vi.fn(async () => responseMessage());
    const message = {
      attachments: new Map(),
      author: { bot: false, id: 'user' },
      channel: {
        isSendable: () => true,
        isThread: () => false,
        send: vi.fn(async () => undefined),
        sendTyping: vi.fn(async () => undefined),
      },
      content: '<@bot>',
      createdTimestamp: 100,
      embeds: [],
      fetch: vi.fn(async function (this: Message) {
        return this;
      }),
      fetchReference,
      id: 'forward-message',
      mentions: { has: () => true },
      messageSnapshots: new Map([
        [
          'source',
          {
            attachments: new Map(),
            content: 'Why does this forwarded Aspire deployment fail?',
            createdTimestamp: 50,
            embeds: [],
          },
        ],
      ]),
      reference: { messageId: 'source', type: MessageReferenceType.Forward },
      reply,
      system: false,
    } as unknown as Message;

    (client as unknown as EventEmitter).emit(Events.MessageCreate, message);

    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalled();
    });
    expect(answers.answer.mock.calls[0]?.[0]).toBe(
      'Why does this forwarded Aspire deployment fail?',
    );
    expect(fetchReference).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('routes a message-context interaction through the selected-message modality', async () => {
    const client = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(createTestConfig(), answers.service, testLogger, client);
    await gateway.start();
    const targetMessage = {
      attachments: new Map(),
      author: { bot: false, id: 'author' },
      cleanContent: 'How do I configure Aspire health checks?',
      content: 'How do I configure Aspire health checks?',
      createdTimestamp: 50,
      embeds: [],
      id: 'target',
      system: false,
    } as unknown as Message;
    const interaction = {
      channel: null,
      commandName: 'Ask Aspirey',
      createdTimestamp: 100,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      id: 'interaction',
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => true,
      reply: vi.fn(async () => undefined),
      targetMessage,
      user: { id: 'user' },
    } as unknown as MessageContextMenuCommandInteraction;

    (client as unknown as EventEmitter).emit(Events.InteractionCreate, interaction);

    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalled();
    });
    expect(answers.answer.mock.calls[0]?.[0]).toBe('How do I configure Aspire health checks?');
    expect(answers.answer.mock.calls[0]?.[3]).toMatchObject({
      questionSource: 'selected',
    });
    await gateway.stop();
  });

  it('unwraps a forwarded snapshot selected through the message-context command', async () => {
    const client = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(createTestConfig(), answers.service, testLogger, client);
    await gateway.start();
    const fetchReference = vi.fn(async () => {
      throw new Error('forward source is intentionally inaccessible');
    });
    const targetMessage = {
      attachments: new Map(),
      author: { bot: false, id: 'author' },
      cleanContent: '',
      content: '',
      createdTimestamp: 50,
      embeds: [],
      fetchReference,
      id: 'target',
      messageSnapshots: new Map([
        [
          'source',
          {
            attachments: new Map(),
            content: 'Why did this forwarded Aspire deployment fail?',
            createdTimestamp: 40,
            embeds: [],
          },
        ],
      ]),
      reference: { messageId: 'source', type: MessageReferenceType.Forward },
      system: false,
    } as unknown as Message;
    const interaction = {
      channel: null,
      commandName: 'Ask Aspirey',
      createdTimestamp: 100,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      id: 'forward-interaction',
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => true,
      reply: vi.fn(async () => undefined),
      targetMessage,
      user: { id: 'user' },
    } as unknown as MessageContextMenuCommandInteraction;

    (client as unknown as EventEmitter).emit(Events.InteractionCreate, interaction);

    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalled();
    });
    expect(answers.answer.mock.calls[0]?.[0]).toBe(
      'Why did this forwarded Aspire deployment fail?',
    );
    expect(answers.answer.mock.calls[0]?.[3]).toMatchObject({
      questionSource: 'forwarded',
    });
    expect(fetchReference).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('includes a selected reply target when handling the message-context command', async () => {
    const client = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(createTestConfig(), answers.service, testLogger, client);
    await gateway.start();
    const targetMessage = {
      attachments: new Map(),
      author: { bot: false, id: 'author' },
      cleanContent: 'Does that Aspire health-check guidance still apply?',
      content: 'Does that Aspire health-check guidance still apply?',
      createdTimestamp: 50,
      embeds: [],
      fetchReference: vi.fn(async () => ({
        attachments: new Map(),
        author: { bot: true, id: 'bot' },
        cleanContent: 'Use AddRedis and configure a health check.',
        content: 'Use AddRedis and configure a health check.',
        createdTimestamp: 40,
        embeds: [],
        id: 'referenced',
      })),
      id: 'target',
      reference: { messageId: 'referenced', type: MessageReferenceType.Default },
      system: false,
    } as unknown as Message;
    const interaction = {
      channel: null,
      commandName: 'Ask Aspirey',
      createdTimestamp: 100,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      id: 'reply-interaction',
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => true,
      reply: vi.fn(async () => undefined),
      targetMessage,
      user: { id: 'user' },
    } as unknown as MessageContextMenuCommandInteraction;

    (client as unknown as EventEmitter).emit(Events.InteractionCreate, interaction);

    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalled();
    });
    expect(answers.answer.mock.calls[0]?.[0]).toBe(
      'Does that Aspire health-check guidance still apply?',
    );
    expect(answers.answer.mock.calls[0]?.[3]).toMatchObject({
      history: expect.stringContaining('Use AddRedis'),
      questionSource: 'selected',
    });
    await gateway.stop();
  });
});
