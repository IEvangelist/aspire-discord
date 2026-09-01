import { EventEmitter } from 'node:events';
import { Events, MessageReferenceType, type Client, type Message } from 'discord.js';
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
    rest: new EventEmitter(),
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

function responseMessage(): Message {
  return {
    edit: vi.fn(async () => undefined),
    reply: vi.fn(async () => responseMessage()),
  } as unknown as Message;
}

function emit(client: Client, message: Message): void {
  (client as unknown as EventEmitter).emit(Events.MessageCreate, message);
}

describe('Discord gateway mention context adapters', () => {
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
        isThread: () => false,
        sendTyping: vi.fn(async () => undefined),
      },
      content: '<@bot>',
      createdTimestamp: 100,
      embeds: [],
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

    emit(client, message);

    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalled();
    });
    expect(answers.answer.mock.calls[0]?.[0]).toBe(
      'Why does this forwarded Aspire deployment fail?',
    );
    expect(answers.answer.mock.calls[0]?.[3]).toMatchObject({
      questionSource: 'forwarded',
    });
    expect(fetchReference).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('uses a replied-to user message when the mention delegates to its context', async () => {
    const client = createClient();
    const answers = createAnswers();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true } }),
      answers.service,
      testLogger,
      client,
    );
    await gateway.start();
    const fetchReference = vi.fn(async () => ({
      attachments: new Map(),
      author: { bot: false, id: 'author' },
      cleanContent: 'How do I configure Aspire health checks?',
      content: 'How do I configure Aspire health checks?',
      createdTimestamp: 50,
      embeds: [],
      id: 'source',
    }));
    const message = {
      attachments: new Map(),
      author: { bot: false, id: 'user' },
      channel: {
        isThread: () => false,
        sendTyping: vi.fn(async () => undefined),
      },
      content: '<@bot> answer the message above',
      createdTimestamp: 100,
      embeds: [],
      fetchReference,
      id: 'reply-message',
      mentions: { has: () => true },
      reference: { messageId: 'source', type: MessageReferenceType.Default },
      reply: vi.fn(async () => responseMessage()),
      system: false,
    } as unknown as Message;

    emit(client, message);

    await vi.waitFor(() => {
      expect(answers.answer).toHaveBeenCalled();
    });
    expect(answers.answer.mock.calls[0]?.[0]).toBe('How do I configure Aspire health checks?');
    expect(answers.answer.mock.calls[0]?.[3]).toMatchObject({
      history: expect.stringContaining('How do I configure Aspire health checks?'),
      questionSource: 'reply',
    });
    expect(fetchReference).toHaveBeenCalledOnce();
    await gateway.stop();
  });
});
