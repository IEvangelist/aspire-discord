import {
  ApplicationCommandType,
  Client,
  ContextMenuCommandBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Message,
  type MessageContextMenuCommandInteraction,
  type TextBasedChannel,
} from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AnswerService, ConversationContext } from '../domain.js';
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
import { buildAnswerMessages } from './formatter.js';
import {
  ImageAttachmentError,
  SafeDiscordImageLoader,
  type DiscordImageCandidate,
} from './image-context.js';
import { resolveModalities, type ResolvedModalityRequest } from './modality-resolver.js';
import { DiscordProgressController, progressMessage } from './progress.js';
import { RequestDeduplicator } from './request-deduplicator.js';
import {
  readForwardedContext,
  readReplyContext,
  readSelectedMessageContext,
  type MessageObservation,
} from './reply-context.js';
import {
  SafeDiscordTextLoader,
  TextAttachmentError,
  type DiscordTextCandidate,
} from './text-context.js';
import { UserRateLimiter } from './user-rate-limiter.js';

const askCommandName = 'ask';
const askMessageCommandName = 'Ask Aspirey';
const interactionDeadlineMilliseconds = 14 * 60_000;
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
  readonly selected?: MessageObservation;
}

type AnswerInteraction = ChatInputCommandInteraction | MessageContextMenuCommandInteraction;

export interface DiscordStatus {
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

export function buildDiscordCommands(maxQuestionLength: number) {
  const ask = new SlashCommandBuilder()
    .setName(askCommandName)
    .setDescription('Ask an Aspire question grounded in official sources.')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription("Optional in a thread; I'll use its conversation and latest question.")
        .setMaxLength(maxQuestionLength)
        .setRequired(false),
    )
    .addAttachmentOption((option) =>
      option
        .setName('image')
        .setDescription('Optional static image to inspect with the question.')
        .setRequired(false),
    )
    .addAttachmentOption((option) =>
      option
        .setName('file')
        .setDescription('Optional UTF-8 code, configuration, Markdown, JSON, or log file.')
        .setRequired(false),
    );
  const askMessage = new ContextMenuCommandBuilder()
    .setName(askMessageCommandName)
    .setType(ApplicationCommandType.Message);
  return [ask.toJSON(), askMessage.toJSON()];
}

export class DiscordGateway {
  readonly #client: Client;
  readonly #imageLoader: SafeDiscordImageLoader;
  readonly #limiter: WorkLimiter;
  readonly #requests = new RequestDeduplicator();
  readonly #textLoader: SafeDiscordTextLoader;
  readonly #users: UserRateLimiter;
  #commandsRegistered = false;
  #started = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly answers: AnswerService,
    private readonly logger: Logger,
    client?: Client,
    private readonly shutdownSignal?: AbortSignal,
  ) {
    this.#client = client ?? new Client(createClientOptions(config.discord.mentionEnabled));
    this.#imageLoader = new SafeDiscordImageLoader(config.imageContext, logger);
    this.#limiter = new WorkLimiter(config.discord.maxConcurrency, config.discord.maxQueue);
    this.#textLoader = new SafeDiscordTextLoader(config.textContext, logger);
    this.#users = new UserRateLimiter(config.discord.maxRequestsPerMinute);
  }

  public get ready(): boolean {
    return !this.config.discord.token || (this.#client.isReady() && this.#commandsRegistered);
  }

  public status(): DiscordStatus {
    if (!this.config.discord.token) {
      return {
        guilds: 0,
        mentionEnabled: this.config.discord.mentionEnabled,
        pingMilliseconds: 0,
        state: 'disabled',
        work: { active: this.#limiter.active, queued: this.#limiter.queued },
      };
    }
    return {
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
    const ready = Promise.withResolvers<undefined>();
    this.#client.once(Events.ClientReady, (client) => {
      void this.#registerCommands(client).then(
        () => {
          this.#commandsRegistered = true;
          ready.resolve(undefined);
        },
        (error: unknown) => {
          ready.reject(error);
        },
      );
    });
    this.#client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
        void this.#handleInteraction(interaction).catch((error: unknown) => {
          this.logger.error({ err: error }, 'Unhandled Discord interaction failure.');
        });
      }
    });
    if (this.config.discord.mentionEnabled) {
      this.#client.on(Events.MessageCreate, (message) => {
        void this.#handleMessage(message).catch((error: unknown) => {
          this.logger.error({ err: error }, 'Unhandled Discord mention failure.');
        });
      });
    }
    this.#client.on(Events.Error, (error) => {
      this.logger.error({ err: error }, 'Discord client error.');
    });
    this.#client.on(Events.ShardError, (error, shardId) => {
      this.logger.error({ err: error, shardId }, 'Discord shard error.');
    });

    if (!this.config.discord.token) {
      this.logger.warn(
        'DISCORD_TOKEN is not configured; the HTTP service will run without Discord.',
      );
      return;
    }

    try {
      await this.#client.login(this.config.discord.token);
      await withTimeout(ready.promise, 30_000, 'Discord command registration timed out.');
      this.logger.info(
        { mentionEnabled: this.config.discord.mentionEnabled },
        'Discord gateway login completed.',
      );
    } catch (error) {
      this.logger.error(
        { err: error },
        'Discord login failed; verify the bot token and privileged intents.',
      );
      await this.#client.destroy();
    }
  }

  public async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    await this.#client.destroy();
  }

  async #registerCommands(readyClient: Client<true>): Promise<void> {
    const commands = buildDiscordCommands(this.config.safety.maxQuestionLength);

    if (this.config.discord.guildId) {
      const guild = await readyClient.guilds.fetch(this.config.discord.guildId);
      await guild.commands.set(commands);
      this.logger.info({ guildId: guild.id }, 'Registered guild Discord commands.');
      return;
    }
    await readyClient.application.commands.set(commands);
    this.logger.info('Registered global Discord commands.');
  }

  async #handleInteraction(interaction: AnswerInteraction): Promise<void> {
    let typed = '';
    let input: ResolveQuestionOptions = {
      beforeTimestamp: interaction.createdTimestamp,
    };
    let interactionKind: 'message-context' | 'slash';
    let selectedTarget: Message | undefined;
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== askCommandName) {
        return;
      }
      interactionKind = 'slash';
      typed = interaction.options.getString('question') ?? '';
      const explicitImage = interaction.options.getAttachment('image');
      const explicitFile = interaction.options.getAttachment('file');
      input = {
        ...input,
        ...(explicitFile
          ? {
              directFiles: [
                {
                  attachment: explicitFile,
                  explicit: true,
                  source: 'current question',
                },
              ],
            }
          : {}),
        ...(explicitImage
          ? {
              directImages: [
                {
                  attachment: explicitImage,
                  explicit: true,
                  source: 'current question',
                },
              ],
            }
          : {}),
      };
    } else {
      if (interaction.commandName !== askMessageCommandName) {
        return;
      }
      interactionKind = 'message-context';
      selectedTarget = interaction.targetMessage;
    }

    if (!isUserAllowed(interaction.user.id, this.config.discord.allowedUserIds)) {
      await interaction.reply({
        content: 'Sorry - this bot is currently restricted to specific users.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.#requests.claim(`interaction:${interaction.id}`)) {
      this.logger.debug('Ignored a duplicate Discord interaction delivery.');
      return;
    }
    const rateLimit = this.#users.acquire(interaction.user.id);
    if (!rateLimit.allowed) {
      await interaction.reply({
        content: rateLimitMessage(rateLimit.retryAfterSeconds),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const sendTyping = typingAction(interaction.channel);
    const progress = new DiscordProgressController({
      logger: this.logger,
      seed: interaction.id,
      ...(sendTyping ? { sendTyping } : {}),
      update: async (content) => await interaction.editReply(answerPayload(content)),
    });
    await progress.start();
    try {
      const requestSignal = this.#requestSignal(
        AbortSignal.timeout(interactionDeadlineMilliseconds),
      );
      if (selectedTarget) {
        const reply = await readReplyContext(
          selectedTarget,
          this.#client.user?.id ?? '',
          this.logger,
        );
        input = {
          ...input,
          forwarded: readForwardedContext(selectedTarget),
          reply,
          selected: readSelectedMessageContext(selectedTarget, this.#client.user?.id ?? ''),
        };
      }
      const resolved = await this.#resolveQuestion(interaction.channel, typed, input);
      if (!resolved.question) {
        await progress.stop();
        await interaction.editReply(resolved.problem);
        return;
      }

      const question = resolved.question;
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
            documentCount: conversation?.documents?.length ?? 0,
            imageCount: conversation?.images?.length ?? 0,
            interactionKind,
            noticeCount: conversation?.notices?.length ?? 0,
            questionLength: question.length,
            questionSource: resolved.questionSource,
            threadContextLength: resolved.context?.length ?? 0,
          },
          'Handling Discord interaction.',
        );
        return await this.answers.answer(
          question,
          requestSignal,
          async (update) => {
            await progress.report(update);
          },
          conversation,
        );
      }, requestSignal);
      const [first, ...rest] = buildAnswerMessages(resolved.displayQuestion ?? question, answer);
      await progress.stop();
      await interaction.editReply(answerPayload(first));
      for (const content of rest) {
        await interaction.followUp(answerPayload(content));
      }
    } catch (error) {
      await progress.stop();
      if (error instanceof WorkQueueFullError) {
        await interaction.editReply('The bot is busy right now. Please retry shortly.');
        return;
      }
      if (error instanceof ImageAttachmentError) {
        await interaction.editReply(error.userMessage);
        return;
      }
      if (error instanceof TextAttachmentError) {
        await interaction.editReply(error.userMessage);
        return;
      }
      this.logger.error({ err: error }, 'Discord interaction failed.');
      await interaction.editReply('Sorry - something went wrong answering that. Please try again.');
    }
  }

  async #handleMessage(message: Message): Promise<void> {
    const requestSignal = this.#requestSignal();
    if (message.author.bot || !this.#client.user || !message.mentions.has(this.#client.user)) {
      return;
    }
    if (!isUserAllowed(message.author.id, this.config.discord.allowedUserIds)) {
      return;
    }
    if (!this.#requests.claim(`message:${message.id}`)) {
      this.logger.debug('Ignored a duplicate Discord message delivery.');
      return;
    }
    const rateLimit = this.#users.acquire(message.author.id);
    if (!rateLimit.allowed) {
      await message.reply(answerPayload(rateLimitMessage(rateLimit.retryAfterSeconds)));
      return;
    }

    const received = await hydrateMessage(message, requestSignal, this.logger);
    const typed = received.content
      .replace(new RegExp(`<@!?${this.#client.user.id}>`, 'gu'), '')
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
      readReplyContext(received, this.#client.user.id, this.logger),
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
      await received.reply(resolved.problem);
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
            imageCount: conversation?.images?.length ?? 0,
            documentCount: conversation?.documents?.length ?? 0,
            noticeCount: conversation?.notices?.length ?? 0,
            questionLength: question.length,
            questionSource: resolved.questionSource,
            threadContextLength: resolved.context?.length ?? 0,
          },
          'Handling Discord mention.',
        );
        return await this.answers.answer(
          question,
          requestSignal,
          async (update) => {
            await progress?.report(update);
          },
          conversation,
        );
      }, requestSignal);
      const [first, ...rest] = buildAnswerMessages(resolved.displayQuestion ?? question, answer);
      await progress.stop();
      await response.edit(answerPayload(first));
      for (const content of rest) {
        if (received.channel.isSendable()) {
          await received.channel.send(answerPayload(content));
        } else {
          await received.reply(answerPayload(content));
        }
      }
    } catch (error) {
      await progress?.stop();
      const content =
        error instanceof WorkQueueFullError
          ? 'The bot is busy right now. Please retry shortly.'
          : error instanceof ImageAttachmentError
            ? error.userMessage
            : error instanceof TextAttachmentError
              ? error.userMessage
              : 'Sorry - something went wrong answering that. Please try again.';
      if (
        !(error instanceof WorkQueueFullError) &&
        !(error instanceof ImageAttachmentError) &&
        !(error instanceof TextAttachmentError)
      ) {
        this.logger.error({ err: error }, 'Discord mention failed.');
      }
      if (progressReply) {
        await progressReply.edit(answerPayload(content));
      } else {
        await received.reply(answerPayload(content));
      }
    }
  }

  async #resolveQuestion(
    channel: TextBasedChannel | null,
    typed: string,
    options: ResolveQuestionOptions = {},
  ): Promise<ResolvedModalityRequest> {
    const { directFiles, directImages, directNotices, forwarded, reply, selected, ...boundary } =
      options;
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
      ...(selected ? { selected } : {}),
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
  };
}

function answerPayload(content: string): {
  readonly allowedMentions: { readonly parse: readonly []; readonly repliedUser: false };
  readonly content: string;
} {
  return {
    allowedMentions: { parse: [], repliedUser: false },
    content,
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
