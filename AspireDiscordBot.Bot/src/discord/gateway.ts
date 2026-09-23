import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type ClientOptions,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AnswerService, ConversationContext } from '../domain.js';
import type { RuntimeConfig, RuntimeConfigSnapshot } from '../runtime-config.js';
import { WorkLimiter, WorkQueueFullError } from '../work-limiter.js';
import { isUserAllowed } from './authorizer.js';
import {
  extractMessageFiles,
  extractMessageImages,
  readThreadContext,
  unsupportedAttachmentNotices,
  type ThreadContextReadOptions,
  type ThreadContextResult,
} from './context-reader.js';
import { buildAnswerThread, type AnswerDetailMessage } from './formatter.js';
import {
  ImageAttachmentError,
  SafeDiscordImageLoader,
  type DiscordImageCandidate,
} from './image-context.js';
import { resolveModalities, type ResolvedModalityRequest } from './modality-resolver.js';
import {
  discordLogContext,
  observeDiscordMention,
  recordDiscordGatewayEvent,
  type DiscordRequestObservation,
  type DiscordRequestOutcome,
} from './observability.js';
import { DiscordProgressController, progressMessage } from './progress.js';
import { RequestDeduplicator } from './request-deduplicator.js';
import {
  readForwardedContext,
  readReplyContext,
  type MessageObservation,
} from './reply-context.js';
import {
  SafeDiscordTextLoader,
  TextAttachmentError,
  type DiscordTextCandidate,
} from './text-context.js';
import { UserRateLimiter } from './user-rate-limiter.js';
import type { DiscordIssueController } from './issue-controller.js';
import {
  ConversationState,
  conversationKey,
  type ConversationActor,
} from './conversation-state.js';

const inlineEmbedRefreshMilliseconds = 750;

interface ResolveQuestionOptions extends Pick<
  ThreadContextReadOptions,
  'beforeMessageId' | 'beforeTimestamp'
> {
  readonly directFiles?: readonly DiscordTextCandidate[];
  readonly directImages?: readonly DiscordImageCandidate[];
  readonly directNotices?: readonly string[];
  readonly forwarded?: MessageObservation;
  readonly reply?: MessageObservation;
}

export interface DiscordStatus {
  readonly issues?: { readonly configured: boolean; readonly enabled: boolean };
  readonly access: {
    readonly allowedUsers: number;
    readonly configurationReady: boolean;
    readonly groundingDetailsMode: RuntimeConfigSnapshot['groundingDetailsMode'];
    readonly mode: 'allowlist' | 'open' | 'unavailable';
    readonly revision: string;
    readonly source: RuntimeConfigSnapshot['source'];
  };
  readonly botUser?: string;
  readonly guilds: number;
  readonly mentionEnabled: boolean;
  readonly pingMilliseconds: number;
  readonly state: 'disabled' | 'offline' | 'ready';
  readonly work: {
    readonly active: number;
    readonly queued: number;
  };
}

export class DiscordGateway {
  readonly #client: Client;
  readonly #imageLoader: SafeDiscordImageLoader;
  readonly #limiter: WorkLimiter;
  readonly #requests = new RequestDeduplicator();
  readonly #textLoader: SafeDiscordTextLoader;
  readonly #users: UserRateLimiter;
  readonly #conversations = new ConversationState();
  readonly #turns = new Map<string, WorkLimiter>();
  #commandsCleared = false;
  #started = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly answers: AnswerService,
    private readonly logger: Logger,
    client?: Client,
    private readonly shutdownSignal?: AbortSignal,
    private readonly runtimeConfig: RuntimeConfig = staticRuntimeConfig(config),
    private readonly issues?: DiscordIssueController,
  ) {
    this.#client = client ?? new Client(createClientOptions(config.discord.mentionEnabled));
    this.#imageLoader = new SafeDiscordImageLoader(config.imageContext, logger);
    this.#limiter = new WorkLimiter(config.discord.maxConcurrency, config.discord.maxQueue);
    this.#textLoader = new SafeDiscordTextLoader(config.textContext, logger);
    this.#users = new UserRateLimiter(config.discord.maxRequestsPerMinute);
  }

  public get ready(): boolean {
    return (
      this.runtimeConfig.current().available &&
      (!this.config.discord.token || (this.#client.isReady() && this.#commandsCleared))
    );
  }

  public status(): DiscordStatus {
    const runtime = this.runtimeConfig.current();
    const access = {
      allowedUsers: runtime.allowedUserIds.size,
      configurationReady: runtime.available,
      groundingDetailsMode: runtime.groundingDetailsMode,
      mode: !runtime.available
        ? ('unavailable' as const)
        : runtime.allowedUserIds.size > 0
          ? ('allowlist' as const)
          : ('open' as const),
      revision: runtime.revision,
      source: runtime.source,
    };
    if (!this.config.discord.token) {
      return {
        ...(this.issues ? { issues: this.issues.status() } : {}),
        access,
        guilds: 0,
        mentionEnabled: this.config.discord.mentionEnabled,
        pingMilliseconds: 0,
        state: 'disabled',
        work: { active: this.#limiter.active, queued: this.#limiter.queued },
      };
    }
    return {
      ...(this.issues ? { issues: this.issues.status() } : {}),
      access,
      ...(this.#client.user ? { botUser: this.#client.user.tag } : {}),
      guilds: this.#client.guilds.cache.size,
      mentionEnabled: this.config.discord.mentionEnabled,
      pingMilliseconds: this.#client.ws.ping,
      state: this.ready ? 'ready' : 'offline',
      work: { active: this.#limiter.active, queued: this.#limiter.queued },
    };
  }

  public async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#commandsCleared = false;
    const ready = Promise.withResolvers<undefined>();
    this.#client.once(
      Events.ClientReady,
      context.bind(ROOT_CONTEXT, (client) => {
        recordDiscordGatewayEvent('ready');
        void this.#clearCommands(client).then(
          () => {
            this.#commandsCleared = true;
            ready.resolve(undefined);
          },
          (error: unknown) => {
            ready.reject(error);
          },
        );
      }),
    );
    if (this.config.discord.mentionEnabled) {
      this.#client.on(
        Events.MessageCreate,
        context.bind(ROOT_CONTEXT, (message) => {
          void this.#handleMessage(message).catch((error: unknown) => {
            this.logger.error(
              { err: error, ...discordLogContext(message) },
              'Unhandled Discord mention failure.',
            );
          });
        }),
      );
      this.#client.on(
        Events.InteractionCreate,
        context.bind(ROOT_CONTEXT, (interaction) => {
          if (interaction.isButton() && interaction.customId.startsWith('issue:') && this.issues) {
            void this.issues
              .handleButton(interaction, this.shutdownSignal)
              .catch((error: unknown) => {
                this.logger.error(
                  {
                    errorType: error instanceof Error ? error.name : 'Error',
                    interactionId: interaction.id,
                  },
                  'Could not complete a Discord issue interaction.',
                );
              });
          }
        }),
      );
    }
    this.#client.on(
      Events.Error,
      context.bind(ROOT_CONTEXT, (error) => {
        recordDiscordGatewayEvent('client_error');
        this.logger.error({ err: error }, 'Discord client error.');
      }),
    );
    this.#client.on(
      Events.ShardError,
      context.bind(ROOT_CONTEXT, (error, shardId) => {
        recordDiscordGatewayEvent('shard_error', shardId);
        this.logger.error({ err: error, shardId }, 'Discord shard error.');
      }),
    );
    this.#client.on(
      Events.ShardDisconnect,
      context.bind(ROOT_CONTEXT, (event, shardId) => {
        recordDiscordGatewayEvent('disconnected', shardId);
        this.logger.warn(
          {
            closeCode: event.code,
            shardId,
          },
          'Discord shard disconnected.',
        );
      }),
    );
    this.#client.on(
      Events.ShardReady,
      context.bind(ROOT_CONTEXT, (shardId, unavailableGuilds) => {
        recordDiscordGatewayEvent('shard_ready', shardId);
        this.logger.info(
          { shardId, unavailableGuildCount: unavailableGuilds?.size ?? 0 },
          'Discord shard is ready.',
        );
      }),
    );
    this.#client.on(
      Events.ShardReconnecting,
      context.bind(ROOT_CONTEXT, (shardId) => {
        recordDiscordGatewayEvent('reconnecting', shardId);
        this.logger.warn({ shardId }, 'Discord shard is reconnecting.');
      }),
    );
    this.#client.on(
      Events.ShardResume,
      context.bind(ROOT_CONTEXT, (shardId, replayedEvents) => {
        recordDiscordGatewayEvent('resumed', shardId);
        this.logger.info({ replayedEvents, shardId }, 'Discord shard resumed.');
      }),
    );
    this.#client.on(
      Events.Invalidated,
      context.bind(ROOT_CONTEXT, () => {
        recordDiscordGatewayEvent('invalidated');
        this.logger.error('Discord session was invalidated.');
      }),
    );
    this.#client.on(
      Events.Warn,
      context.bind(ROOT_CONTEXT, (warning) => {
        recordDiscordGatewayEvent('warning');
        this.logger.warn({ warning }, 'Discord client warning.');
      }),
    );
    this.#client.rest.on('rateLimited', (rateLimit) => {
      recordDiscordGatewayEvent('rest_rate_limited');
      this.logger.warn(
        {
          global: rateLimit.global,
          limit: rateLimit.limit,
          method: rateLimit.method,
          retryAfterMilliseconds: rateLimit.retryAfter,
          route: rateLimit.route,
          scope: rateLimit.scope,
          sublimitTimeoutMilliseconds: rateLimit.sublimitTimeout,
          timeToResetMilliseconds: rateLimit.timeToReset,
        },
        'Discord REST request was rate limited.',
      );
    });
    this.#client.rest.on('invalidRequestWarning', (warning) => {
      recordDiscordGatewayEvent('rest_invalid_request');
      this.logger.warn(
        {
          invalidRequestCount: warning.count,
          remainingWindowMilliseconds: warning.remainingTime,
        },
        'Discord REST invalid-request threshold warning.',
      );
    });

    if (!this.config.discord.token) {
      this.logger.warn(
        'DISCORD_TOKEN is not configured; the HTTP service will run without Discord.',
      );
      return;
    }

    try {
      await this.#client.login(this.config.discord.token);
    } catch (error) {
      recordDiscordGatewayEvent('login_failed');
      this.logger.error(
        { err: error },
        'Discord login failed; verify the bot token and privileged intents.',
      );
      await this.#client.destroy();
      return;
    }

    try {
      await withTimeout(ready.promise, 30_000, 'Discord command cleanup timed out.');
    } catch (error) {
      recordDiscordGatewayEvent('command_cleanup_failed');
      this.logger.error({ err: error }, 'Discord command cleanup failed after login.');
      await this.#client.destroy();
      return;
    }

    const runtime = this.runtimeConfig.current();
    this.logger.info(
      {
        allowedUserCount: runtime.allowedUserIds.size,
        authorizationMode: !runtime.available
          ? 'unavailable'
          : runtime.allowedUserIds.size > 0
            ? 'allowlist'
            : 'open',
        groundingDetailsMode: runtime.groundingDetailsMode,
        guildCount: this.#client.guilds.cache.size,
        mentionEnabled: this.config.discord.mentionEnabled,
        runtimeConfigRevision: runtime.revision,
        runtimeConfigSource: runtime.source,
      },
      'Discord gateway login completed.',
    );
  }

  public async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    await this.#client.destroy();
    recordDiscordGatewayEvent('stopped');
  }

  async #clearCommands(readyClient: Client<true>): Promise<void> {
    await readyClient.application.commands.set([]);
    if (this.config.discord.guildId) {
      const guild = await readyClient.guilds.fetch(this.config.discord.guildId);
      await guild.commands.set([]);
      this.logger.info({ guildId: guild.id }, 'Cleared legacy guild Discord commands.');
    }
    this.logger.info('Cleared legacy global Discord commands.');
  }

  async #handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !this.#client.user) {
      return;
    }
    if (!message.mentions.has(this.#client.user)) {
      const runtime = this.runtimeConfig.current();
      if (!runtime.available || !isUserAllowed(message.author.id, runtime.allowedUserIds)) return;
      if (!this.#conversations.get(this.#actor(message))?.requiresReply) {
        if (!message.reference?.messageId) return;
        await this.issues?.handleMessage(message, this.#client.user, this.shutdownSignal);
        return;
      }
    }
    await observeDiscordMention(message, async (observation) => {
      try {
        await this.#processMention(message, observation);
      } catch (error) {
        observation.fail(error);
        this.logger.error(
          { err: error, ...discordLogContext(message), outcome: 'failed' },
          'Unhandled Discord mention failure.',
        );
      }
    });
  }

  async #processMention(message: Message, observation: DiscordRequestObservation): Promise<void> {
    const runtime = this.runtimeConfig.current();
    if (!runtime.available || !isUserAllowed(message.author.id, runtime.allowedUserIds)) {
      await this.#processConversationTurn(message, observation);
      return;
    }
    const key = conversationKey(this.#actor(message));
    const turns = this.#turns.get(key) ?? new WorkLimiter(1, 2);
    this.#turns.set(key, turns);
    try {
      await turns.run(
        () => this.#processConversationTurn(message, observation),
        this.#requestSignal(),
      );
    } catch (error) {
      if (!(error instanceof WorkQueueFullError)) throw error;
      this.logger.warn({ ...discordLogContext(message) }, 'Requester conversation queue is full.');
      await message.reply(
        answerPayload('I am still handling your previous messages. Please wait for my reply.'),
      );
      observation.complete('busy');
    } finally {
      if (turns.active === 0 && turns.queued === 0) this.#turns.delete(key);
    }
  }

  #actor(message: Message): ConversationActor {
    return { userId: message.author.id, guildId: message.guildId, channelId: message.channelId };
  }

  async #processConversationTurn(
    message: Message,
    observation: DiscordRequestObservation,
  ): Promise<void> {
    if (
      this.#client.user &&
      !message.mentions.has(this.#client.user) &&
      !this.#conversations.get(this.#actor(message))?.requiresReply
    ) {
      const current = this.runtimeConfig.current();
      if (
        current.available &&
        isUserAllowed(message.author.id, current.allowedUserIds) &&
        message.reference?.messageId &&
        (await this.issues?.handleMessage(message, this.#client.user, this.shutdownSignal))
      ) {
        this.#conversations.clear(this.#actor(message));
        observation.complete('issue_handled');
      } else {
        this.logger.info(
          discordLogContext(message),
          'Ignored a queued message after conversation completion.',
        );
        observation.complete('unclassified');
      }
      return;
    }
    const started = performance.now();
    const logContext = discordLogContext(message);
    const requestSignal = this.#requestSignal();
    const runtime = this.runtimeConfig.current();
    if (!runtime.available) {
      await message.reply(
        answerPayload('The bot access configuration is unavailable. Please try again shortly.'),
      );
      this.logger.error(
        { ...logContext, outcome: 'configuration_unavailable' },
        'Rejected Discord mention because runtime configuration is unavailable.',
      );
      observation.complete('configuration_unavailable');
      return;
    }
    if (!isUserAllowed(message.author.id, runtime.allowedUserIds)) {
      this.logger.warn(
        {
          ...logContext,
          allowedUserCount: runtime.allowedUserIds.size,
          outcome: 'not_authorized',
        },
        'Ignored Discord mention from a user outside the allowlist.',
      );
      observation.complete('not_authorized');
      return;
    }
    if (!this.#requests.claim(`message:${message.id}`)) {
      this.logger.info(
        { ...logContext, outcome: 'duplicate' },
        'Ignored duplicate Discord mention.',
      );
      observation.complete('duplicate');
      return;
    }
    const rateLimit = this.#users.acquire(message.author.id);
    if (!rateLimit.allowed) {
      await message.reply(answerPayload(rateLimitMessage(rateLimit.retryAfterSeconds)));
      this.logger.warn(
        { ...logContext, outcome: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds },
        'Rate limited Discord mention.',
      );
      observation.complete('rate_limited');
      return;
    }

    if (
      this.issues &&
      this.#client.user &&
      (await this.issues.handleMessage(message, this.#client.user, requestSignal))
    ) {
      this.#conversations.clear(this.#actor(message));
      observation.complete('issue_handled');
      return;
    }

    this.logger.info({ ...logContext, outcome: 'received' }, 'Received Discord mention.');
    const received = await hydrateMessage(message, requestSignal, this.logger);
    const typed = received.content
      .replace(new RegExp(`<@!?${this.#client.user?.id ?? ''}>`, 'gu'), '')
      .trim();
    const directImages = extractMessageImages(received).map(
      (attachment) =>
        ({
          attachment,
          explicit: true,
          source: 'current question',
        }) satisfies DiscordImageCandidate,
    );
    const directFiles = extractMessageFiles(received).map(
      (attachment) =>
        ({
          attachment,
          explicit: true,
          source: 'current question',
        }) satisfies DiscordTextCandidate,
    );
    const [reply, forwarded] = await Promise.all([
      readReplyContext(received, this.#client.user?.id ?? '', this.logger),
      Promise.resolve(readForwardedContext(received)),
    ]);
    const resolved = await this.#resolveQuestion(received.channel, typed, {
      beforeMessageId: received.id,
      beforeTimestamp: received.createdTimestamp,
      ...(directFiles.length > 0 ? { directFiles } : {}),
      ...(directImages.length > 0 ? { directImages } : {}),
      directNotices: unsupportedAttachmentNotices(received),
      forwarded,
      reply,
    });
    if (!resolved.question) {
      await received.reply(answerPayload(resolved.problem));
      this.logger.info(
        { ...logContext, outcome: 'invalid_question' },
        'Discord mention did not contain a resolvable question.',
      );
      observation.complete('invalid_question');
      return;
    }

    let progress: DiscordProgressController | undefined;
    let progressReply: Message | undefined;
    try {
      if ('sendTyping' in received.channel) {
        await received.channel.sendTyping();
      }
      const question = resolved.question;
      const response = await received.reply(answerPayload(progressMessage('reading', received.id)));
      progressReply = response;
      const sendTyping = typingAction(received.channel);
      progress = new DiscordProgressController({
        logger: this.logger,
        seed: received.id,
        ...(sendTyping ? { sendTyping } : {}),
        update: async (content) => await response.edit(answerPayload(content)),
      });
      await progress.start(true);
      const answer = await this.#limiter.run(async () => {
        const conversation = await this.#loadConversation(
          resolved.context,
          resolved.imageCandidates ?? [],
          resolved.fileCandidates ?? [],
          resolved.notices ?? [],
          resolved.requiresProcessedAttachment ?? false,
          resolved.questionSource,
          requestSignal,
        );
        this.logger.info(
          {
            ...logContext,
            activeWork: this.#limiter.active,
            documentCount: conversation?.documents?.length ?? 0,
            imageCount: conversation?.images?.length ?? 0,
            noticeCount: conversation?.notices?.length ?? 0,
            questionLength: question.length,
            questionSource: resolved.questionSource,
            queuedWork: this.#limiter.queued,
            threadContextLength: resolved.context?.length ?? 0,
          },
          'Handling Discord mention.',
        );
        const previous = this.#conversations.get(this.#actor(message));
        const bot = this.#client.user;
        const issues = this.issues;
        const history = [previous?.history, conversation?.history].filter(Boolean).join('\n\n');
        const combined: ConversationContext | undefined =
          conversation || previous || (issues && bot)
            ? {
                ...conversation,
                ...(history ? { history } : {}),
                ...(previous?.pendingIssue ? { pendingIssue: previous.pendingIssue } : {}),
                ...(issues && bot
                  ? {
                      prepareIssueDraft: (input, signal) =>
                        issues.prepareDraft(received, bot, input, signal),
                    }
                  : {}),
              }
            : undefined;
        return await this.answers.answer(
          question,
          requestSignal,
          async (update) => {
            await progress?.report(update);
          },
          combined,
        );
      }, requestSignal);
      const formatted = buildAnswerThread(
        resolved.displayQuestion ?? question,
        answer,
        runtime.groundingDetailsMode,
      );
      await progress.stop();
      await response.edit(answerPayload(formatted.answerMessages[0]));
      this.#conversations.remember(this.#actor(message), question, answer);
      await replyInChain(response, [
        ...formatted.answerMessages.slice(1),
        ...formatted.detailMessages,
      ]);
      const responseMessageCount =
        formatted.answerMessages.length + formatted.detailMessages.length;
      const outcome = answer.isGrounded ? 'answered' : 'not_grounded';
      const telemetryAttributes = {
        'aspire.discord.answer.grounded': answer.isGrounded,
        'aspire.discord.question.source': resolved.questionSource,
        'aspire.discord.response.message_count': responseMessageCount,
      };
      observation.complete(outcome, telemetryAttributes);
      this.logger.info(
        {
          ...logContext,
          citationCount: answer.citations.length,
          durationMilliseconds: Math.round(performance.now() - started),
          grounded: answer.isGrounded,
          outcome,
          questionSource: resolved.questionSource,
          responseMessageCount,
        },
        'Discord mention completed.',
      );
    } catch (error) {
      try {
        await progress?.stop();
      } catch (progressError) {
        this.logger.warn(
          { err: progressError, ...logContext },
          'Could not stop Discord progress updates after a failure.',
        );
      }
      const failure = classifyMentionFailure(error);
      if (failure.outcome === 'failed') {
        this.logger.error(
          { err: error, ...logContext, outcome: failure.outcome },
          'Discord mention failed.',
        );
      } else {
        this.logger.warn(
          {
            ...logContext,
            errorType: error instanceof Error ? error.name : 'Error',
            outcome: failure.outcome,
          },
          'Discord mention was rejected before completion.',
        );
      }
      if (failure.outcome === 'failed') {
        observation.fail(error);
      }
      if (progressReply) {
        await progressReply.edit(answerPayload(failure.content));
      } else {
        await received.reply(answerPayload(failure.content));
      }
      if (failure.outcome !== 'failed') {
        observation.complete(failure.outcome);
      }
    }
  }

  async #resolveQuestion(
    channel: TextBasedChannel | null,
    typed: string,
    options: ResolveQuestionOptions = {},
  ): Promise<ResolvedModalityRequest> {
    const { directFiles, directImages, directNotices, forwarded, reply, ...boundary } = options;
    const thread =
      channel?.isThread() &&
      this.#client.user &&
      channel.permissionsFor(this.#client.user)?.has(PermissionFlagsBits.ReadMessageHistory) ===
        false
        ? ({ status: 'forbidden' } satisfies ThreadContextResult)
        : channel
          ? await readThreadContext(
              channel,
              {
                ...boundary,
                ...(this.#client.user ? { botUserId: this.#client.user.id } : {}),
                maxQuestionLength: this.config.safety.maxQuestionLength,
              },
              this.logger,
            )
          : ({ status: 'not-a-thread' } satisfies ThreadContextResult);
    return resolveModalities({
      ...(directFiles ? { directFiles } : {}),
      ...(directImages ? { directImages } : {}),
      ...(directNotices ? { directNotices } : {}),
      ...(forwarded ? { forwarded } : {}),
      ...(reply ? { reply } : {}),
      thread,
      typed,
    });
  }

  async #loadConversation(
    history: string | undefined,
    imageCandidates: readonly DiscordImageCandidate[],
    fileCandidates: readonly DiscordTextCandidate[],
    notices: readonly string[],
    requiresProcessedAttachment: boolean,
    questionSource: string,
    signal?: AbortSignal,
  ): Promise<ConversationContext | undefined> {
    const [imageContext, textContext] = await Promise.all([
      this.#imageLoader.load(imageCandidates, signal),
      this.#textLoader.load(fileCandidates, signal),
    ]);
    if (
      requiresProcessedAttachment &&
      imageContext.images.length === 0 &&
      textContext.documents.length === 0
    ) {
      throw new ImageAttachmentError(
        'I could not safely read the context attachment. Please attach a supported image or UTF-8 text file.',
      );
    }
    const allNotices = [...notices, ...imageContext.notices, ...textContext.notices];
    return history ||
      imageContext.images.length > 0 ||
      textContext.documents.length > 0 ||
      allNotices.length > 0 ||
      questionSource !== 'none'
      ? {
          ...(textContext.documents.length > 0 ? { documents: textContext.documents } : {}),
          ...(history ? { history } : {}),
          ...(imageContext.images.length > 0 ? { images: imageContext.images } : {}),
          ...(allNotices.length > 0 ? { notices: [...new Set(allNotices)] } : {}),
          questionSource,
        }
      : undefined;
  }

  #requestSignal(deadline?: AbortSignal): AbortSignal | undefined {
    if (deadline && this.shutdownSignal) {
      return AbortSignal.any([deadline, this.shutdownSignal]);
    }
    return deadline ?? this.shutdownSignal;
  }
}

function classifyMentionFailure(error: unknown): {
  readonly content: string;
  readonly outcome: DiscordRequestOutcome;
} {
  if (error instanceof WorkQueueFullError) {
    return {
      content: 'The bot is busy right now. Please retry shortly.',
      outcome: 'busy',
    };
  }
  if (error instanceof ImageAttachmentError) {
    return { content: error.userMessage, outcome: 'image_rejected' };
  }
  if (error instanceof TextAttachmentError) {
    return { content: error.userMessage, outcome: 'text_rejected' };
  }
  return {
    content: 'Sorry - something went wrong answering that. Please try again.',
    outcome: 'failed',
  };
}

function staticRuntimeConfig(config: AppConfig): RuntimeConfig {
  const runtime: RuntimeConfigSnapshot = {
    issuePolicy: config.issues.policy,
    issuePolicyAvailable: true,
    allowedUserIds: config.discord.allowedUserIds,
    available: true,
    groundingDetailsMode: config.discord.groundingDetailsMode,
    revision: 'environment',
    source: 'environment',
  };
  return {
    current: () => runtime,
    refresh: async () => undefined,
    stop: () => undefined,
  };
}

async function replyInChain(
  root: Message,
  contents: readonly (string | AnswerDetailMessage)[],
): Promise<void> {
  let parent = root;
  for (const content of contents) {
    parent = await parent.reply(answerPayload(content));
  }
}

async function hydrateMessage(
  message: Message,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<Message> {
  if (
    message.embeds.length === 0 &&
    extractMessageImages(message).length === 0 &&
    /https?:\/\//iu.test(message.content)
  ) {
    try {
      await delay(inlineEmbedRefreshMilliseconds, undefined, {
        ...(signal ? { signal } : {}),
      });
      return await message.fetch(true);
    } catch (error) {
      if (!signal?.aborted) {
        logger.info(
          { errorType: error instanceof Error ? error.name : 'Error' },
          'Could not refresh asynchronous Discord embeds; using the original message.',
        );
      }
    }
  }
  return message;
}

function typingAction(channel: TextBasedChannel | null): (() => Promise<unknown>) | undefined {
  return channel && 'sendTyping' in channel
    ? async () => {
        await channel.sendTyping();
      }
    : undefined;
}

function createClientOptions(mentionEnabled: boolean): ClientOptions {
  return {
    intents: mentionEnabled
      ? [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ]
      : [GatewayIntentBits.Guilds],
    rest: {
      invalidRequestWarningInterval: 500,
    },
  };
}

function answerPayload(content: string | AnswerDetailMessage): {
  readonly allowedMentions: { readonly parse: readonly []; readonly repliedUser: false };
  readonly components?: NonNullable<AnswerDetailMessage['components']>;
  readonly content: string;
} {
  return {
    allowedMentions: { parse: [], repliedUser: false },
    ...(typeof content === 'string'
      ? { content }
      : {
          ...(content.components ? { components: content.components } : {}),
          content: content.content,
        }),
  };
}

function rateLimitMessage(retryAfterSeconds: number): string {
  return `You're asking questions too quickly. Please retry in about ${String(retryAfterSeconds)} seconds.`;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMilliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
