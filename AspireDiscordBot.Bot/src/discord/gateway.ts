import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AnswerService } from '../domain.js';
import { WorkLimiter, WorkQueueFullError } from '../work-limiter.js';
import { resolveQuestion, referencesThread } from './ask-resolver.js';
import { isUserAllowed } from './authorizer.js';
import { readOriginalPost, type OriginalPostResult } from './context-reader.js';
import { buildAnswerMessages } from './formatter.js';

const askCommandName = 'ask';
const interactionDeadlineMilliseconds = 14 * 60_000;

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

export class DiscordGateway {
  readonly #client: Client;
  readonly #limiter: WorkLimiter;
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
    this.#limiter = new WorkLimiter(config.discord.maxConcurrency, config.discord.maxQueue);
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
      if (interaction.isChatInputCommand()) {
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
    const command = new SlashCommandBuilder()
      .setName(askCommandName)
      .setDescription('Ask an Aspire question grounded in official sources.')
      .addStringOption((option) =>
        option
          .setName('question')
          .setDescription("Optional in a forum thread; I'll answer the original post.")
          .setMaxLength(this.config.safety.maxQuestionLength)
          .setRequired(false),
      )
      .toJSON();

    if (this.config.discord.guildId) {
      const guild = await readyClient.guilds.fetch(this.config.discord.guildId);
      await guild.commands.set([command]);
      this.logger.info({ guildId: guild.id }, 'Registered guild Discord commands.');
      return;
    }
    await readyClient.application.commands.set([command]);
    this.logger.info('Registered global Discord commands.');
  }

  async #handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== askCommandName) {
      return;
    }
    if (!isUserAllowed(interaction.user.id, this.config.discord.allowedUserIds)) {
      await interaction.reply({
        content: 'Sorry — this bot is currently restricted to specific users.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    try {
      const requestSignal = this.#requestSignal(
        AbortSignal.timeout(interactionDeadlineMilliseconds),
      );
      const typed = interaction.options.getString('question') ?? '';
      const resolved = await this.#resolveQuestion(interaction.channel, typed);
      if (!resolved.question) {
        await interaction.editReply(resolved.problem);
        return;
      }

      this.logger.info(
        { question: truncateForLog(resolved.question), userId: interaction.user.id },
        'Handling Discord slash command.',
      );
      const question = resolved.question;
      const answer = await this.#limiter.run(
        async () => await this.answers.answer(question, requestSignal),
        requestSignal,
      );
      const [first, ...rest] = buildAnswerMessages(question, answer);
      await interaction.editReply(answerPayload(first));
      for (const content of rest) {
        await interaction.followUp(answerPayload(content));
      }
    } catch (error) {
      if (error instanceof WorkQueueFullError) {
        await interaction.editReply('The bot is busy right now. Please retry shortly.');
        return;
      }
      this.logger.error({ err: error }, 'Discord slash command failed.');
      await interaction.editReply('Sorry — something went wrong answering that. Please try again.');
    }
  }

  async #handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !this.#client.user || !message.mentions.has(this.#client.user)) {
      return;
    }
    if (!isUserAllowed(message.author.id, this.config.discord.allowedUserIds)) {
      return;
    }

    const typed = message.content
      .replace(new RegExp(`<@!?${this.#client.user.id}>`, 'gu'), '')
      .trim();
    const resolved = await this.#resolveQuestion(message.channel, typed);
    if (!resolved.question) {
      await message.reply(resolved.problem);
      return;
    }

    try {
      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }
      const question = resolved.question;
      const requestSignal = this.#requestSignal();
      const answer = await this.#limiter.run(
        async () => await this.answers.answer(question, requestSignal),
        requestSignal,
      );
      const [first, ...rest] = buildAnswerMessages(question, answer);
      await message.reply(answerPayload(first));
      for (const content of rest) {
        if (message.channel.isSendable()) {
          await message.channel.send(answerPayload(content));
        } else {
          await message.reply(answerPayload(content));
        }
      }
    } catch (error) {
      if (error instanceof WorkQueueFullError) {
        await message.reply('The bot is busy right now. Please retry shortly.');
        return;
      }
      this.logger.error({ err: error }, 'Discord mention failed.');
      await message.reply('Sorry — something went wrong answering that. Please try again.');
    }
  }

  async #resolveQuestion(
    channel: TextBasedChannel | null,
    typed: string,
  ): Promise<{ problem: string; question?: string }> {
    const original = channel
      ? await readOriginalPost(channel, this.config.safety.maxQuestionLength, this.logger)
      : ({ status: 'not-a-thread' } satisfies OriginalPostResult);
    const question = resolveQuestion(typed, original.question);
    if (question) {
      return { problem: '', question };
    }

    if (typed.trim() && !referencesThread(typed)) {
      return {
        problem: "Please include an Aspire question and I'll answer from official sources.",
      };
    }
    return { problem: originalPostProblem(original.status) };
  }

  #requestSignal(deadline?: AbortSignal): AbortSignal | undefined {
    if (deadline && this.shutdownSignal) {
      return AbortSignal.any([deadline, this.shutdownSignal]);
    }
    return deadline ?? this.shutdownSignal;
  }
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

function originalPostProblem(status: OriginalPostResult['status']): string {
  switch (status) {
    case 'forbidden':
      return (
        "I couldn't read the original post because I'm missing **Read Message History**. " +
        'Grant that permission or paste the question here.'
      );
    case 'empty':
      return "The original post doesn't contain readable text. Paste the question here.";
    case 'not-a-thread':
      return 'Run `/ask` inside a forum post/thread or include a question directly.';
    case 'error':
      return "I couldn't read the original post. Paste the question here.";
    case 'found':
      return 'Please include a question.';
  }
}

function truncateForLog(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 120)}…`;
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
