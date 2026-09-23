import { metrics, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Message,
  type MessageCreateOptions,
  type User,
} from 'discord.js';
import type { Logger } from 'pino';
import {
  IssueClarificationError,
  isIssueRequest,
  type IssueDraftGenerator,
  type IssueContext,
} from '../issues/drafting.js';
import type { IssueWorkflow } from '../issues/workflow.js';
import {
  IssueConflictError,
  IssuePolicyError,
  IssuePublishError,
  type IssueActor,
  type IssueDraft,
  type IssuePolicy,
} from '../issues/types.js';
import { WorkLimiter, WorkQueueFullError } from '../work-limiter.js';
import { readThreadContext } from './context-reader.js';
import { UserRateLimiter } from './user-rate-limiter.js';
import { RequestDeduplicator } from './request-deduplicator.js';
import { isIssueLocationAllowed } from '../issues/policy.js';

type Workflow = Pick<
  IssueWorkflow,
  'create' | 'get' | 'revise' | 'attachPreview' | 'confirm' | 'cancel' | 'reconcile'
>;
const tracer = trace.getTracer('AspireDiscordBot.Issues');
const actions = metrics
  .getMeter('AspireDiscordBot.Issues')
  .createCounter('aspire.github_issue.actions', {
    description: 'Discord issue actions by outcome.',
    unit: '{action}',
  });
const referencePattern = /Issue draft: ([a-f0-9-]{36}) v(\d+)\./u;
const clarificationMarker = '[Issue drafting clarification]';
const revisionClarificationPattern =
  /Issue revision clarification: ([a-f0-9-]{36}) v(\d+) preview (\d+)\.\n\[Issue drafting clarification\]$/u;
const actionPattern = /^issue:(confirm|cancel|status):([a-f0-9-]{36}):(\d+)$/u;

export interface DiscordIssueServices {
  readonly workflow: Workflow;
  readonly generator: Pick<IssueDraftGenerator, 'generate'>;
}

interface DraftReference {
  readonly id: string;
  readonly version: number;
  readonly messageId: string;
}

export class DiscordIssueController {
  readonly #limiter = new WorkLimiter(2, 4);
  readonly #users = new UserRateLimiter(6);
  readonly #requests = new RequestDeduplicator();

  public constructor(
    private readonly services: DiscordIssueServices | undefined,
    private readonly getPolicy: () => IssuePolicy,
    private readonly logger: Logger,
  ) {}

  public status(): { readonly configured: boolean; readonly enabled: boolean } {
    return { configured: Boolean(this.services), enabled: this.getPolicy().enabled };
  }

  public async handleMessage(message: Message, bot: User, signal?: AbortSignal): Promise<boolean> {
    const mentioned = message.mentions.has(bot);
    const requested = mentioned && isIssueRequest(message.content);
    let reference: DraftReference | undefined;
    let clarification: Message | undefined;
    const policy = this.getPolicy();
    if (
      message.reference?.messageId &&
      !message.author.bot &&
      policy.enabled &&
      policy.allowedUserIds.includes(message.author.id) &&
      isIssueLocationAllowed(policy, message.guildId, message.channelId)
    ) {
      if (message.reference.channelId && message.reference.channelId !== message.channelId) {
        if (requested) {
          await message.reply(
            textReply(
              'Please use the original channel or thread. Cross-channel issue context is not supported.',
            ),
          );
          return true;
        }
        return false;
      }
      const referenced = await message.fetchReference().catch((error: unknown) => {
        this.logger.warn(
          { errorType: error instanceof Error ? error.name : 'Error' },
          'Issue reply reference could not be read.',
        );
        return undefined;
      });
      if (referenced?.author.id === bot.id) {
        const match = referencePattern.exec(referenced.content);
        if (match?.[1] && match[2]) {
          reference = { id: match[1], version: Number(match[2]), messageId: referenced.id };
        } else if (
          referenced.content.endsWith(clarificationMarker) &&
          referenced.reference?.messageId
        ) {
          const original = await referenced.fetchReference();
          if (
            original.author.id === message.author.id &&
            original.channelId === message.channelId
          ) {
            clarification = original;
            const revision = revisionClarificationPattern.exec(referenced.content);
            if (revision?.[1] && revision[2] && revision[3]) {
              reference = { id: revision[1], version: Number(revision[2]), messageId: revision[3] };
            }
          }
        }
      }
    }
    if (!requested && !reference && !clarification) {
      return false;
    }
    if (!this.#requests.claim(`message:${message.id}`)) {
      actions.add(1, { outcome: 'duplicate' });
      this.logger.info({ messageId: message.id }, 'Ignored duplicate issue request.');
      return true;
    }
    if (!this.#users.acquire(message.author.id).allowed) {
      actions.add(1, { outcome: 'rate_limited' });
      this.logger.warn({ userId: message.author.id }, 'Ignored rate-limited issue request.');
      return true;
    }
    await this.#observe(message.author.id, message.channelId, message.id, async () => {
      try {
        const actor = this.#authorize(message.author.id, message.guildId, message.channelId);
        const services = this.#configured();
        const currentRequest = message.content
          .replace(new RegExp(`<@!?${bot.id}>`, 'gu'), '')
          .trim();
        const request = clarification
          ? `File a GitHub issue. Earlier request: ${clarification.content.slice(0, 4_000)}\nAdditional details: ${currentRequest.slice(0, 4_000)}`
          : currentRequest;
        const deadline = AbortSignal.timeout(120_000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const draft = await this.#limiter.run(async () => {
          if (reference) {
            if (!clarification) {
              if (/^(?:yes|ok|okay|sure)[.!]?$/iu.test(request)) {
                throw new IssuePolicyError(
                  'Please review the full preview, then click Create issue or explicitly reply "create the issue". Nothing has been published.',
                );
              }
              if (
                /^(?:yes[,.]?\s*(?:create|publish|file)\s+(?:it|the issue)|(?:create|publish|file)\s+(?:it|the issue)|confirm)[.!]?$/iu.test(
                  request,
                )
              ) {
                return await services.workflow.confirm(
                  actor,
                  reference.id,
                  reference.version,
                  reference.messageId,
                  combined,
                );
              }
              if (/^(?:no|cancel|cancel it|cancel the issue|never mind)[.!]?$/iu.test(request)) {
                return await services.workflow.cancel(
                  actor,
                  reference.id,
                  reference.version,
                  combined,
                );
              }
              if (
                /^(?:status|check status|did it (?:work|publish)|was it filed)[?!.]?$/iu.test(
                  request,
                )
              ) {
                const existing = await services.workflow.get(actor, reference.id, {
                  allowExpired: true,
                  signal: combined,
                });
                if (
                  existing.version !== reference.version ||
                  existing.previewMessageId !== reference.messageId
                ) {
                  throw new IssueConflictError();
                }
                return existing.state === 'publishing' || existing.state === 'unknown'
                  ? await services.workflow.reconcile(actor, reference.id, combined)
                  : existing;
              }
            }
            const previous = await services.workflow.get(actor, reference.id, { signal: combined });
            if (
              previous.version !== reference.version ||
              previous.previewMessageId !== reference.messageId
            ) {
              throw new IssueConflictError();
            }
            const input = await services.generator.generate(
              request,
              { text: '', sourceMessageIds: [message.id], notices: previous.notices },
              this.getPolicy().allowedRepositories,
              previous,
              combined,
            );
            return await services.workflow.revise(
              actor,
              reference.id,
              reference.version,
              input,
              combined,
            );
          }
          const evidence = await this.#context(clarification ?? message, bot);
          const input = await services.generator.generate(
            request,
            evidence,
            this.getPolicy().allowedRepositories,
            undefined,
            combined,
          );
          return await services.workflow.create(actor, input, combined);
        }, combined);
        this.#recordOutcome(draft);
        await this.#respond(message, actor, draft, combined);
      } catch (error) {
        this.#logFailure(error);
        await message.reply(textReply(userError(error, reference)));
      }
    });
    return true;
  }

  public async handleButton(interaction: ButtonInteraction, signal?: AbortSignal): Promise<void> {
    const match = actionPattern.exec(interaction.customId);
    if (!match?.[1] || !match[2] || !match[3]) {
      await interaction.reply({
        content: 'This issue control is invalid.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const id = match[2];
    const version = Number(match[3]);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.#observe(interaction.user.id, interaction.channelId, interaction.id, async () => {
      try {
        const actor = this.#authorize(
          interaction.user.id,
          interaction.guildId,
          interaction.channelId,
        );
        this.#rateLimit(actor.userId);
        const { workflow } = this.#configured();
        const deadline = AbortSignal.timeout(120_000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const draft = await this.#limiter.run(async () => {
          if (match[1] === 'confirm') {
            return await workflow.confirm(actor, id, version, interaction.message.id, combined);
          }
          const existing = await workflow.get(actor, id, {
            allowExpired: match[1] === 'status',
            signal: combined,
          });
          if (
            existing.version !== version ||
            existing.previewMessageId !== interaction.message.id
          ) {
            throw new IssueConflictError();
          }
          return match[1] === 'cancel'
            ? await workflow.cancel(actor, id, version, combined)
            : existing.state === 'publishing' || existing.state === 'unknown'
              ? await workflow.reconcile(actor, id, combined)
              : existing;
        }, combined);
        this.#recordOutcome(draft);
        await interaction.editReply({
          content: outcomeText(draft),
          allowedMentions: { parse: [] },
        });
        if (draft.state === 'published' || draft.state === 'cancelled') {
          await interaction.message.edit({ components: [] }).catch((error: unknown) => {
            this.logger.warn(
              { draftId: draft.id, errorType: error instanceof Error ? error.name : 'Error' },
              'Could not remove completed issue controls.',
            );
          });
        }
      } catch (error) {
        this.#logFailure(error);
        await interaction.editReply({ content: userError(error), allowedMentions: { parse: [] } });
      }
    });
  }

  async #respond(
    message: Message,
    actor: IssueActor,
    draft: IssueDraft,
    signal?: AbortSignal,
  ): Promise<void> {
    if (draft.state !== 'draft') {
      await message.reply(textReply(outcomeText(draft)));
      return;
    }
    const preview = await message.reply(issuePreview(draft));
    await this.#configured().workflow.attachPreview(
      actor,
      draft.id,
      draft.version,
      preview.id,
      signal,
    );
  }

  #authorize(userId: string, guildId: string | null, channelId: string): IssueActor {
    const policy = this.getPolicy();
    if (!policy.enabled) {
      throw new IssuePolicyError(
        'GitHub issue filing is disabled or its access configuration is unavailable.',
      );
    }
    if (
      !guildId ||
      !policy.allowedUserIds.includes(userId) ||
      !isIssueLocationAllowed(policy, guildId, channelId)
    ) {
      throw new IssuePolicyError(
        'You are not authorized to file issues in this channel. Filing access is separate from answering questions.',
      );
    }
    return { userId, guildId, channelId };
  }

  #configured(): DiscordIssueServices {
    if (!this.services) {
      throw new IssuePolicyError(
        'Issue filing needs a GitHub App Key Vault signing key and durable storage configured by an operator. Installing the app alone is not sufficient.',
      );
    }
    return this.services;
  }

  #rateLimit(userId: string): void {
    if (!this.#users.acquire(userId).allowed) {
      throw new IssuePolicyError(
        'Too many issue requests. Please wait a minute before trying again.',
      );
    }
  }

  async #context(message: Message, bot: User): Promise<IssueContext> {
    const thread = await readThreadContext(
      message.channel,
      {
        botUserId: bot.id,
        beforeMessageId: message.id,
        beforeTimestamp: message.createdTimestamp,
        maxQuestionLength: 4_000,
      },
      this.logger,
    );
    if (thread.status === 'error' || thread.status === 'forbidden') {
      throw new IssuePolicyError(
        'I could not read this thread. Please provide the relevant redacted details explicitly.',
      );
    }
    const parts = [thread.context ?? ''];
    const ids = [message.id, ...(thread.messageIds ?? [])];
    if (message.reference?.messageId) {
      const referenced = await message.fetchReference();
      parts.push(referenced.content.slice(0, 4_000));
      ids.push(referenced.id);
    }
    return {
      text: parts.filter(Boolean).join('\n\n').slice(0, 12_000),
      sourceMessageIds: [...new Set(ids)].slice(-100),
      notices: [
        thread.status === 'not-a-thread'
          ? 'Context: this request and its replied-to message only; other channel history was not read.'
          : 'Context is bounded: thread starter and selected recent messages (up to 50 fetched, 20 selected, 8,000 characters). Older or longer details may be omitted.',
        'Attachments, participant identities and Discord links are not published. Review for confidential details.',
      ],
    };
  }

  async #observe(
    userId: string,
    channelId: string,
    eventId: string,
    execute: () => Promise<void>,
  ): Promise<void> {
    await tracer.startActiveSpan(
      'process discord issue request',
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'ai.operation.name': 'process discord issue request',
          'discord.user.id': userId,
          'discord.channel.id': channelId,
          'messaging.message.id': eventId,
          'messaging.system': 'discord',
          'messaging.operation.name': 'process',
          'aspire.discord.request.kind': 'github_issue',
        },
      },
      ROOT_CONTEXT,
      async (span) => {
        try {
          this.logger.info(
            { discordEventId: eventId, discordUserId: userId, discordChannelId: channelId },
            'Received Discord issue action.',
          );
          await execute();
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  #logFailure(error: unknown): void {
    const type = error instanceof Error ? error.name : 'Error';
    const outcome = error instanceof IssuePolicyError ? 'rejected' : 'failed';
    actions.add(1, { outcome });
    trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
    trace.getActiveSpan()?.setAttribute('aspire.discord.request.outcome', `issue_${outcome}`);
    this.logger.warn({ errorType: type, outcome }, 'Discord issue action did not complete.');
  }

  #recordOutcome(draft: IssueDraft): void {
    actions.add(1, { outcome: draft.state });
    trace.getActiveSpan()?.setAttributes({
      'aspire.discord.request.outcome': `issue_${draft.state}`,
      'aspire.github_issue.state': draft.state,
      'aspire.github_issue.draft_id': draft.id,
    });
  }
}

export function issuePreview(draft: IssueDraft): MessageCreateOptions {
  const audience =
    draft.visibility === 'public'
      ? 'PUBLIC: visible to everyone'
      : 'PRIVATE: visible to people with repository access';
  const duplicateLines = draft.duplicates
    .slice(0, 5)
    .map((issue) => `#${String(issue.number)}: ${issue.url}`)
    .join('\n');
  const embed = new EmbedBuilder()
    .setTitle(draft.title)
    .setDescription(draft.body)
    .addFields({ name: 'Repository and audience', value: `${draft.repository}\n${audience}` })
    .setFooter({ text: `Version ${String(draft.version)} | Expires ${draft.expiresAt}` });
  if (duplicateLines) {
    embed.addFields({
      name: 'Possible existing issues - review before filing',
      value: duplicateLines.slice(0, 1_024),
    });
  }
  return {
    content: [
      '**Review before publishing.** This draft contains a summary of Discord conversation data. Creating it will disclose the exact attached title/body to the repository audience and may notify subscribers.',
      ...draft.notices.slice(0, 3).map((notice) => notice.slice(0, 400)),
      'Reply to this preview with changes, or explicitly reply "create the issue". Only the requester can approve. A plain "yes" does not publish.',
      `Issue draft: ${draft.id} v${String(draft.version)}.`,
    ]
      .join('\n\n')
      .slice(0, 2_000),
    embeds: [embed],
    files: [
      new AttachmentBuilder(Buffer.from(`# ${draft.title}\n\n${draft.body}\n`, 'utf8'), {
        name: 'issue-preview.md',
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`issue:confirm:${draft.id}:${String(draft.version)}`)
          .setLabel('Create issue')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`issue:cancel:${draft.id}:${String(draft.version)}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`issue:status:${draft.id}:${String(draft.version)}`)
          .setLabel('Check status')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

function textReply(content: string): MessageCreateOptions {
  return { content, allowedMentions: { parse: [], repliedUser: false } };
}

function outcomeText(draft: IssueDraft): string {
  if (draft.state === 'published' && draft.result) {
    return `GitHub issue created: ${draft.result.url}`;
  }
  if (draft.state === 'cancelled') {
    return 'Issue draft cancelled. Nothing was published.';
  }
  if (draft.state === 'failed') {
    return 'GitHub rejected the submission. No automatic retry was made. An operator can inspect the failure before you prepare another draft.';
  }
  if (draft.state === 'publishing' || draft.state === 'unknown') {
    return 'The publication outcome is not yet confirmed. It may already exist on GitHub. Use Check status on the preview; do not create another issue. No automatic re-submission will occur.';
  }
  return Date.parse(draft.expiresAt) <= Date.now()
    ? 'This unsubmitted preview has expired. Request a new draft before publishing.'
    : 'The draft is awaiting your review. Use the original preview to approve or revise it.';
}

function userError(error: unknown, reference?: DraftReference): string {
  if (error instanceof IssueClarificationError) {
    const binding = reference
      ? `Issue revision clarification: ${reference.id} v${String(reference.version)} preview ${reference.messageId}.\n`
      : '';
    return `${error.message}\n\nReply to this message with the missing details; nothing has been published.\n${binding}${clarificationMarker}`;
  }
  if (
    error instanceof IssuePolicyError ||
    error instanceof IssueConflictError ||
    error instanceof IssuePublishError
  ) {
    return error.message;
  }
  if (error instanceof WorkQueueFullError) {
    return 'The issue workflow is busy. Please try again shortly.';
  }
  return 'The issue action could not be completed. If you were publishing, use Check status on the preview before trying anything else. No automatic re-submission was made.';
}
