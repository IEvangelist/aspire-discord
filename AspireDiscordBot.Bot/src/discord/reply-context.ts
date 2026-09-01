import { MessageReferenceType } from 'discord.js';
import type { Logger } from 'pino';
import { sanitizeForAgent, truncateAtGrapheme } from '../safety.js';
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

export interface DiscordReplySource {
  readonly fetchReference: () => Promise<ThreadMessageSnapshot>;
  readonly reference: {
    readonly messageId: string | undefined;
    readonly type?: MessageReferenceType;
  } | null;
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
    const referenced = await source.fetchReference();
    return buildMessageObservation(
      referenced,
      referenced.author.id === botUserId
        ? 'Replied-to assistant answer'
        : referenced.author.bot
          ? 'Replied-to bot message'
          : 'Replied-to user message',
      'replied-to message',
      maximumReplyCharacters,
      !referenced.author.bot,
    );
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
