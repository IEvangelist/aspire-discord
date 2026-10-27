import { MessageReferenceType } from 'discord.js';
import type { Logger } from 'pino';
import { evaluateQuestion, sanitizeForAgent, truncateAtGrapheme } from '../safety.js';
import { needsConversationReferent } from './context-reference.js';
import {
  extractMessageFiles,
  extractMessageImages,
  unsupportedAttachmentNotices,
  type ThreadMessageSnapshot,
} from './context-reader.js';
import type { DiscordImageCandidate } from './image-context.js';
import type { DiscordTextCandidate } from './text-context.js';

const maximumReplyCharacters = 2_000;
const maximumForwardCharacters = 4_000;
const maximumReplyDepth = 4;

export interface DiscordReplySource {
  readonly fetchReference: () => Promise<ReferencedMessage>;
  readonly reference: {
    readonly messageId: string | undefined;
    readonly type?: MessageReferenceType;
  } | null;
}

export interface ReferencedMessage extends ThreadMessageSnapshot {
  readonly fetchReference?: () => Promise<ReferencedMessage>;
  readonly reference?: DiscordReplySource['reference'];
}

export interface DiscordForwardSource {
  readonly messageSnapshots?: {
    values(): IterableIterator<DiscordForwardSnapshot>;
  };
}

export interface DiscordForwardSnapshot {
  readonly attachments?: ThreadMessageSnapshot['attachments'];
  readonly content: string;
  readonly createdTimestamp: number;
  readonly embeds?: ThreadMessageSnapshot['embeds'];
}

export interface MessageObservation {
  readonly context?: string;
  readonly files: readonly DiscordTextCandidate[];
  readonly images: readonly DiscordImageCandidate[];
  readonly messageId?: string;
  readonly notices: readonly string[];
  readonly question?: string;
  readonly requiresAttachment?: boolean;
  readonly status: 'empty' | 'error' | 'found' | 'none';
}

export async function readReplyContext(
  source: DiscordReplySource,
  botUserId: string,
  logger: Logger,
): Promise<MessageObservation> {
  if (
    !source.reference?.messageId ||
    (source.reference.type !== undefined && source.reference.type !== MessageReferenceType.Default)
  ) {
    return emptyObservation('none');
  }
  try {
    const seen = new Set<string>();
    const observations: MessageObservation[] = [];
    let referenced = await source.fetchReference();
    while (observations.length < maximumReplyDepth && !seen.has(referenced.id)) {
      seen.add(referenced.id);
      observations.push(
        buildMessageObservation(
          referenced,
          referenced.author.id === botUserId
            ? 'Replied-to assistant answer'
            : referenced.author.bot
              ? 'Replied-to bot message'
              : 'Replied-to user message',
          'replied-to message',
          maximumReplyCharacters,
          !referenced.author.bot,
        ),
      );
      if (
        !referenced.reference?.messageId ||
        (referenced.reference.type !== undefined &&
          referenced.reference.type !== MessageReferenceType.Default) ||
        !referenced.fetchReference
      ) break;
      try {
        referenced = await referenced.fetchReference();
      } catch (error) {
        logger.info(
          { errorType: error instanceof Error ? error.name : 'Error' },
          'Could not read an earlier Discord reply ancestor.',
        );
        return mergeReplyObservations(observations, [
          'An earlier message in the reply chain could not be read.',
        ]);
      }
    }
    return mergeReplyObservations(observations, referenced.reference?.messageId &&
      observations.length === maximumReplyDepth
      ? ['The reply chain is longer than the context that was read.']
      : []);
  } catch (error) {
    logger.info(
      { errorType: error instanceof Error ? error.name : 'Error' },
      'Could not read a replied-to Discord message.',
    );
    return {
      ...emptyObservation('error'),
      notices: ['The replied-to message could not be read, so it was omitted from context.'],
    };
  }
}

function mergeReplyObservations(
  observations: readonly MessageObservation[],
  extraNotices: readonly string[],
): MessageObservation {
  const question = observations.find(
    (observation) => observation.question && !needsConversationReferent(observation.question),
  )?.question ?? observations.find((observation) => observation.question)?.question;
  const contexts = observations
    .map((observation) => observation.context)
    .filter((context): context is string => Boolean(context))
    .reverse();
  const context = truncateAtGrapheme(contexts.join('\n\n'), maximumForwardCharacters);
  const notices = [...new Set([
    ...observations.flatMap((observation) => observation.notices),
    ...extraNotices,
  ])];
  return {
    ...(context ? { context } : {}),
    files: observations.flatMap((observation) => observation.files),
    images: observations.flatMap((observation) => observation.images),
    ...(observations[0]?.messageId ? { messageId: observations[0].messageId } : {}),
    notices,
    ...(question ? { question } : {}),
    ...(observations.some((observation) => observation.requiresAttachment)
      ? { requiresAttachment: true }
      : {}),
    status: observations.some((observation) => observation.status === 'error')
      ? 'error'
      : observations.some((observation) => observation.status === 'found') ? 'found' : 'empty',
  };
}

export function readForwardedContext(source: DiscordForwardSource): MessageObservation {
  const snapshots = [...(source.messageSnapshots?.values() ?? [])].slice(0, 1);
  if (snapshots.length === 0) {
    return emptyObservation('none');
  }
  const snapshot = snapshots[0];
  if (!snapshot) {
    return emptyObservation('none');
  }
  return buildMessageObservation(
    {
      ...(snapshot.attachments ? { attachments: snapshot.attachments } : {}),
      author: { bot: false, id: 'forwarded' },
      cleanContent: snapshot.content,
      content: snapshot.content,
      createdTimestamp: snapshot.createdTimestamp,
      ...(snapshot.embeds ? { embeds: snapshot.embeds } : {}),
      id: 'forwarded-message',
    },
    'Forwarded message',
    'forwarded message',
    maximumForwardCharacters,
    true,
  );
}

function buildMessageObservation(
  message: ThreadMessageSnapshot,
  label: string,
  source: DiscordImageCandidate['source'],
  maximumCharacters: number,
  useAsQuestion: boolean,
): MessageObservation {
  const text = (message.cleanContent.trim() || message.content.trim()).trim();
  if (text && !evaluateQuestion(text, maximumCharacters).isAllowed) {
    return {
      ...emptyObservation('error'),
      notices: ['The referenced message failed safety checks and was omitted from context.'],
    };
  }
  const images = extractMessageImages(message).map(
    (attachment) =>
      ({
        attachment,
        explicit: true,
        source,
      }) satisfies DiscordImageCandidate,
  );
  const files = extractMessageFiles(message).map(
    (attachment) =>
      ({
        attachment,
        explicit: true,
        source,
      }) satisfies DiscordTextCandidate,
  );
  const notices = unsupportedAttachmentNotices(message);
  const markers = [
    images.length > 0
      ? `[${String(images.length)} image${images.length === 1 ? '' : 's'} attached]`
      : '',
    files.length > 0
      ? `[${String(files.length)} text file${files.length === 1 ? '' : 's'} attached]`
      : '',
  ].filter(Boolean);
  const content = [truncateAtGrapheme(sanitizeForAgent(text), maximumCharacters), ...markers]
    .filter(Boolean)
    .join('\n');
  if (!content && notices.length === 0) {
    return emptyObservation('empty');
  }
  return {
    ...(content ? { context: `[${label}]\n${content}` } : {}),
    files,
    images,
    messageId: message.id,
    notices,
    ...(useAsQuestion && text ? { question: text } : {}),
    ...(!text && (images.length > 0 || files.length > 0) ? { requiresAttachment: true } : {}),
    status: 'found',
  };
}

function emptyObservation(status: MessageObservation['status']): MessageObservation {
  return {
    files: [],
    images: [],
    notices: [],
    status,
  };
}
