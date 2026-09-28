import { EventEmitter } from 'node:events';
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { Events, type Client, type Message, type MessageCreateOptions } from 'discord.js';
import pino, { type Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AnswerService, GroundedAnswer } from '../../src/domain.js';
import { DiscordGateway } from '../../src/discord/gateway.js';
import type { DiscordAttachmentSnapshot } from '../../src/discord/image-context.js';
import type { RuntimeConfig, RuntimeConfigSnapshot } from '../../src/runtime-config.js';
import { WorkQueueFullError } from '../../src/work-limiter.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';
import { useTestTelemetry } from '../helpers/telemetry.js';
import { DiscordIssueController } from '../../src/discord/issue-controller.js';
import { disabledIssuePolicy } from '../../src/issues/policy.js';

const exporter = useTestTelemetry();
const tracer = trace.getTracer('gateway-behavior-tests');

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
  readonly channelId?: string;
  readonly guildId?: string | null;
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
    return { id: String(index + 1000), edit, reply } as unknown as Message;
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
    channelId: options.channelId ?? 'channel',
    embeds: [],
    guildId: options.guildId === undefined ? 'guild' : options.guildId,
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
    {
      level: 'debug',
      mixin: () => ({ testTraceId: trace.getActiveSpan()?.spanContext().traceId }),
    },
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
  it('passes OP evidence separately and retains it across a repository-only clarification', async () => {
    const client = createClient();
    const answers = createAnswers();
    answers.answer.mockResolvedValueOnce({
      answer: 'Which repository?',
      citations: [],
      isGrounded: false,
      topScore: 0,
      source: 'conversation',
      requiresReply: true,
      pendingIssue: {
        title: 'Telemetry hook runs outside Aspire',
        body: 'Reported pwsh failures after every tool call.',
      },
    });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      testLogger,
      client.client,
    );
    await gateway.start();
    const initial = createMessage({
      id: 'first-context',
      content: '<@bot> Draft an issue from the OP report; figure out title and description.',
    });
    const report =
      'The hook ./aspire/hooks/track-telemetry.ps1 runs after every tool call, and pwsh is missing. Not sure whether an Aspire project was in the repo.';
    const starter = {
      id: 'report',
      author: { id: 'op-user', bot: false },
      content: report,
      cleanContent: report,
      createdTimestamp: 1,
    };
    Object.assign(initial.message.channel, {
      name: 'Post Tool Call Hook Issue',
      isThread: () => true,
      permissionsFor: () => ({ has: () => true }),
      fetchStarterMessage: async () => starter,
      messages: { fetch: async () => new Map([['report', starter]]) },
    });
    emit(client.client, initial.message);
    await vi.waitFor(() => expect(initial.chain.nodes[0]?.edit).toHaveBeenCalled());
    expect(answers.answer.mock.calls[0]?.[3]?.sourceContext).toContain('track-telemetry.ps1');
    expect(answers.answer.mock.calls[0]?.[3]?.history).not.toContain('track-telemetry.ps1');
    expect(initial.chain.calls).toHaveLength(0);
    const reply = createMessage({ id: 'repo-only', content: 'microsoft/aspire', mentioned: false });
    emit(client.client, reply.message);
    await vi.waitFor(() => expect(answers.answer).toHaveBeenCalledTimes(2));
    expect(answers.answer.mock.calls[1]?.[3]).toMatchObject({
      sourceContext: expect.stringContaining('track-telemetry.ps1'),
      pendingIssue: expect.objectContaining({ title: 'Telemetry hook runs outside Aspire' }),
      history: expect.stringContaining('figure out title'),
    });
    await gateway.stop();
  });

  it('reuses the progress reply for a prepared preview without a duplicate status or footer', async () => {
    const client = createClient();
    const answers = createAnswers();
    const issues = new DiscordIssueController(undefined, () => disabledIssuePolicy, testLogger);
    const prepare = vi
      .spyOn(issues, 'prepareDraft')
      .mockImplementation(async (_message, _bot, _input, _signal, target) => {
        if (!target) throw new Error('Missing progress preview target.');
        await target.edit({ content: 'Review this draft', embeds: [], components: [] });
        return { draftId: 'draft', version: 1 };
      });
    answers.answer.mockImplementation(async (_question, signal, _progress, conversation) => {
      await conversation?.prepareIssueDraft?.(
        { repository: 'microsoft/aspire', title: 'Hook issue', body: 'Reported failure' },
        signal,
      );
      return {
        answer: 'I prepared the preview.',
        citations: [],
        isGrounded: false,
        topScore: 0,
        source: 'conversation',
      };
    });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      testLogger,
      client.client,
      undefined,
      undefined,
      issues,
    );
    await gateway.start();
    const request = createMessage({ content: '<@bot> Draft this report' });
    emit(client.client, request.message);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(request.chain.nodes[0]?.edit).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Review this draft' }),
      ),
    );
    expect(request.reply).toHaveBeenCalledOnce();
    expect(request.chain.calls).toHaveLength(0);
    expect(request.chain.nodes[0]?.edit).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('I prepared') }),
    );
    await gateway.stop();
  });

  it('stops consuming unmentioned chatter after a feedback acknowledgment', async () => {
    const client = createClient();
    const answers = createAnswers();
    answers.answer
      .mockResolvedValueOnce({
        answer: 'Which repository?',
        citations: [],
        isGrounded: false,
        topScore: 0,
        source: 'conversation',
        requiresReply: true,
        pendingIssue: { title: 'Hook issue', body: 'A reported failure' },
      })
      .mockResolvedValueOnce({
        answer: 'You should not have to repeat that. I have kept the draft.',
        citations: [],
        isGrounded: false,
        topScore: 0,
        source: 'conversation',
        requiresReply: false,
        pendingIssue: { title: 'Hook issue', body: 'A reported failure' },
      });
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      testLogger,
      client.client,
    );
    await gateway.start();
    const start = createMessage({ id: 'start-feedback' });
    emit(client.client, start.message);
    await vi.waitFor(() => expect(start.chain.nodes[0]?.edit).toHaveBeenCalled());
    const feedback = createMessage({
      id: 'feedback',
      content: 'This is frustrating',
      mentioned: false,
    });
    emit(client.client, feedback.message);
    await vi.waitFor(() => expect(feedback.chain.nodes[0]?.edit).toHaveBeenCalled());
    const chatter = createMessage({ id: 'after-feedback', mentioned: false });
    emit(client.client, chatter.message);
    const resume = createMessage({ id: 'resume-mentioned', content: '<@bot> microsoft/aspire' });
    emit(client.client, resume.message);
    await vi.waitFor(() => expect(answers.answer).toHaveBeenCalledTimes(3));
    expect(chatter.reply).not.toHaveBeenCalled();
    expect(answers.answer.mock.calls[2]?.[3]?.pendingIssue?.title).toBe('Hook issue');
    expect(feedback.chain.calls).toHaveLength(0);
    await gateway.stop();
  });
  it('does not consume a queued bare message after an earlier turn completes the pending task', async () => {
    const client = createClient();
    const answers = createAnswers();
    const captured = createCapturingLogger();
    const pending = Promise.withResolvers<GroundedAnswer>();
    answers.answer
      .mockResolvedValueOnce({
        answer: 'Which repository?',
        citations: [],
        isGrounded: false,
        topScore: 0,
        requiresReply: true,
        pendingIssue: { title: 'Testing', body: '1.2.3' },
      })
      .mockImplementationOnce(() => pending.promise);
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      captured.logger,
      client.client,
    );
    await gateway.start();
    const first = createMessage({ id: 'first' });
    emit(client.client, first.message);
    await vi.waitFor(() => expect(first.chain.nodes[0]?.edit).toHaveBeenCalled());
    const second = createMessage({ id: 'second', content: 'aspire.dev', mentioned: false });
    emit(client.client, second.message);
    await vi.waitFor(() => expect(answers.answer).toHaveBeenCalledTimes(2));
    const unrelated = createMessage({
      id: 'after-completion',
      content: 'Something else for the channel',
      mentioned: false,
    });
    emit(client.client, unrelated.message);
    pending.resolve({ answer: 'Preview ready.', citations: [], isGrounded: false, topScore: 0 });
    await vi.waitFor(() =>
      expect(captured.entries).toContainEqual(
        expect.objectContaining({
          msg: 'Ignored a queued message after conversation completion.',
        }),
      ),
    );
    expect(answers.answer).toHaveBeenCalledTimes(2);
    expect(unrelated.reply).not.toHaveBeenCalled();
    await gateway.stop();
  });
  it.each([false, true])(
    'continues the same requester pending draft from a bare or mentioned repository reply (mention=%s)',
    async (mentioned) => {
      const client = createClient();
      const answers = createAnswers();
      answers.answer.mockResolvedValueOnce({
        answer: 'Which repository?',
        citations: [],
        isGrounded: false,
        topScore: 0,
        source: 'conversation',
        requiresReply: true,
        pendingIssue: { title: 'Testing', body: '1.2.3' },
      });
      const gateway = new DiscordGateway(
        createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
        answers.service,
        testLogger,
        client.client,
      );
      await gateway.start();
      const initial = createMessage({
        id: 'create-1',
        content: '<@bot> create an issue. Use the subject Testing and the desc 1.2.3',
      });
      emit(client.client, initial.message);
      await vi.waitFor(() => expect(initial.chain.nodes[0]?.edit).toHaveBeenCalled());
      const otherUser = createMessage({
        id: 'other-user',
        content: 'aspire.dev',
        mentioned: false,
        userId: 'other',
      });
      const otherChannel = createMessage({
        id: 'other-channel',
        content: 'aspire.dev',
        mentioned: false,
        channelId: 'other',
      });
      const otherGuild = createMessage({
        id: 'other-guild',
        content: 'aspire.dev',
        mentioned: false,
        guildId: 'other',
      });
      emit(client.client, otherUser.message);
      emit(client.client, otherChannel.message);
      emit(client.client, otherGuild.message);
      const followup = createMessage({
        id: 'repo-2',
        content: mentioned ? '<@bot> aspire.dev' : 'aspire.dev',
        mentioned,
      });
      emit(client.client, followup.message);
      await vi.waitFor(() => expect(answers.answer).toHaveBeenCalledTimes(2));
      expect(answers.answer.mock.calls[1]?.[0]).toBe('aspire.dev');
      expect(answers.answer.mock.calls[1]?.[3]).toMatchObject({
        pendingIssue: { title: 'Testing', body: '1.2.3' },
        history: expect.stringContaining('subject Testing'),
      });
      expect(otherUser.reply).not.toHaveBeenCalled();
      expect(otherChannel.reply).not.toHaveBeenCalled();
      expect(otherGuild.reply).not.toHaveBeenCalled();
      await gateway.stop();
    },
  );

  it('keeps ordinary questions in Q&A when issue services are present but disabled', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const issues = new DiscordIssueController(undefined, () => disabledIssuePolicy, testLogger);
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      testLogger,
      harness.client,
      undefined,
      undefined,
      issues,
    );
    await gateway.start();
    const request = createMessage({
      content: 'Can I create an Aspire AppHost without hitting this issue?',
    });
    emit(harness.client, request.message);
    await vi.waitFor(() => expect(answers.answer).toHaveBeenCalledOnce());
    expect(request.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('issue filing is disabled'),
      }),
    );
    await gateway.stop();
  });

  it('applies the existing allowlist, deduplication and rate limits before issue dispatch', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const issues = new DiscordIssueController(undefined, () => disabledIssuePolicy, testLogger);
    const dispatch = vi
      .spyOn(issues, 'prepareDraft')
      .mockResolvedValue({ draftId: 'draft', version: 1 });
    answers.answer.mockImplementation(async (_question, signal, _progress, conversation) => {
      if (!conversation?.prepareIssueDraft) throw new Error('Expected trusted draft capability.');
      await conversation.prepareIssueDraft(
        { repository: 'microsoft/aspire', title: 'Testing', body: '1.2.3' },
        signal,
      );
      return {
        answer: 'Review the preview.',
        citations: [],
        isGrounded: false,
        topScore: 0,
        source: 'conversation',
      };
    });
    const gateway = new DiscordGateway(
      createTestConfig({
        discord: {
          mentionEnabled: true,
          token: 'token',
          allowedUserIds: new Set(['allowed']),
          maxRequestsPerMinute: 1,
        },
      }),
      answers.service,
      testLogger,
      harness.client,
      undefined,
      undefined,
      issues,
    );
    await gateway.start();
    const denied = createMessage({
      id: 'denied-issue',
      userId: 'denied',
      content: 'File an issue',
    });
    const allowed = createMessage({
      id: 'allowed-issue',
      userId: 'allowed',
      content: 'File an issue',
    });
    const limited = createMessage({
      id: 'limited-issue',
      userId: 'allowed',
      content: 'File an issue',
    });
    emit(harness.client, denied.message);
    emit(harness.client, allowed.message);
    await vi.waitFor(() => expect(allowed.reply).toHaveBeenCalledOnce());
    emit(harness.client, allowed.message);
    emit(harness.client, limited.message);
    await vi.waitFor(() =>
      expect(limited.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('retry in about'),
        }),
      ),
    );
    expect(denied.reply).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(allowed.reply).toHaveBeenCalledOnce();
    expect(answers.answer).toHaveBeenCalledOnce();
    await gateway.stop();
  });

  it('routes tool-selected previews and human buttons through separate trusted capabilities', async () => {
    const harness = createClient();
    const answers = createAnswers();
    const issues = new DiscordIssueController(undefined, () => disabledIssuePolicy, testLogger);
    const prepareDraft = vi
      .spyOn(issues, 'prepareDraft')
      .mockResolvedValue({ draftId: 'draft', version: 1 });
    answers.answer.mockImplementation(async (_question, signal, _progress, conversation) => {
      if (!conversation?.prepareIssueDraft) throw new Error('Expected trusted draft capability.');
      await conversation.prepareIssueDraft(
        { repository: 'microsoft/aspire', title: 'Testing', body: '1.2.3' },
        signal,
      );
      return {
        answer: 'Review the preview.',
        citations: [],
        isGrounded: false,
        topScore: 0,
        source: 'conversation',
      };
    });
    const handleButton = vi.spyOn(issues, 'handleButton').mockResolvedValue(undefined);
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      testLogger,
      harness.client,
      undefined,
      undefined,
      issues,
    );
    await gateway.start();
    const { message } = createMessage({ content: '<@bot> file an issue' });
    emit(harness.client, message);
    const interaction = {
      isButton: () => true,
      customId: 'issue:confirm:example:1',
      id: 'interaction',
    };
    (harness.client as unknown as EventEmitter).emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => {
      expect(prepareDraft).toHaveBeenCalledOnce();
      expect(handleButton).toHaveBeenCalledWith(interaction, undefined);
    });
    expect(answers.answer).toHaveBeenCalledOnce();
    await gateway.stop();
  });

  it('marks an undeliverable rejection as failed, not successfully busy', async () => {
    const harness = createClient();
    const captured = createCapturingLogger();
    const answers = createAnswers();
    answers.answer.mockRejectedValueOnce(new WorkQueueFullError(0));
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      answers.service,
      captured.logger,
      harness.client,
    );
    await gateway.start();
    const { message, chain } = createMessage();
    chain.nodes[0]?.edit.mockRejectedValue(new Error('Discord response edit denied'));
    emit(harness.client, message);
    await vi.waitFor(() => {
      expect(exporter.getFinishedSpans().some((span) => span.kind === SpanKind.CONSUMER)).toBe(
        true,
      );
    });
    const request = exporter.getFinishedSpans().find((span) => span.kind === SpanKind.CONSUMER);
    expect(request?.status.code).toBe(SpanStatusCode.ERROR);
    expect(request?.attributes['aspire.discord.request.outcome']).toBe('failed');
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        msg: 'Unhandled Discord mention failure.',
        outcome: 'failed',
        testTraceId: request?.spanContext().traceId,
      }),
    );
    await gateway.stop();
  });

  it('does not correlate gateway lifecycle logs with an unrelated request', async () => {
    const harness = createClient();
    const captured = createCapturingLogger();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      createAnswers().service,
      captured.logger,
      harness.client,
    );
    await gateway.start();
    await tracer.startActiveSpan('unrelated request', async (span) => {
      (harness.client as unknown as EventEmitter).emit(Events.ShardReconnecting, 0);
      (harness.client as unknown as EventEmitter).emit(Events.ShardResume, 0, 1);
      span.end();
    });
    const lifecycle = captured.entries.filter(
      (entry) =>
        entry.msg === 'Discord shard is reconnecting.' || entry.msg === 'Discord shard resumed.',
    );
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.every((entry) => entry.testTraceId === undefined)).toBe(true);
    await gateway.stop();
  });

  it('keeps failures before answer generation on the failed mention trace', async () => {
    const harness = createClient();
    const captured = createCapturingLogger();
    const gateway = new DiscordGateway(
      createTestConfig({ discord: { mentionEnabled: true, token: 'token' } }),
      createAnswers().service,
      captured.logger,
      harness.client,
    );
    await gateway.start();
    const { message, reply } = createMessage({ content: '<@bot>' });
    reply.mockRejectedValueOnce(new Error('Discord reply denied'));
    context.with(ROOT_CONTEXT, () => emit(harness.client, message));
    await vi.waitFor(() => {
      expect(
        captured.entries.some((entry) => entry.msg === 'Unhandled Discord mention failure.'),
      ).toBe(true);
    });
    const request = exporter.getFinishedSpans().find((span) => span.kind === SpanKind.CONSUMER);
    expect(request?.status.code).toBe(SpanStatusCode.ERROR);
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        msg: 'Unhandled Discord mention failure.',
        outcome: 'failed',
        testTraceId: request?.spanContext().traceId,
      }),
    );
    await gateway.stop();
  });

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
