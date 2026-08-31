import { DiscordAPIError, type TextBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import { evaluateQuestion, sanitizeForAgent } from '../safety.js';
import {
  isPotentialImageAttachment,
  type DiscordAttachmentSnapshot,
  type DiscordImageCandidate,
  type DiscordImageSource,
} from './image-context.js';

const maximumFetchedMessages = 50;
const maximumHistoryMessages = 20;
const maximumTurnLength = 1_200;

export const THREAD_CONTEXT_MAX_LENGTH = 8_000;

export type ThreadContextStatus = 'empty' | 'error' | 'forbidden' | 'found' | 'not-a-thread';

export interface ThreadContextResult {
  readonly context?: string;
  readonly images?: readonly DiscordImageCandidate[];
  readonly question?: string;
  readonly status: ThreadContextStatus;
}

export interface ThreadContextReadOptions {
  readonly beforeMessageId?: string;
  readonly beforeTimestamp?: number;
  readonly botUserId?: string;
  readonly maxQuestionLength: number;
}

export interface ThreadMessageSnapshot {
  readonly attachments?: {
    values(): IterableIterator<DiscordAttachmentSnapshot>;
  };
  readonly author: {
    readonly bot: boolean;
    readonly id: string;
  };
  readonly cleanContent: string;
  readonly content: string;
  readonly createdTimestamp: number;
  readonly id: string;
  readonly system?: boolean;
}

interface ThreadTurn {
  readonly authorId: string;
  readonly content: string;
  readonly id: string;
  readonly images: readonly DiscordAttachmentSnapshot[];
  readonly isAssistant: boolean;
  readonly isHuman: boolean;
  readonly question: string;
  readonly timestamp: number;
}

export async function readThreadContext(
  channel: TextBasedChannel,
  options: ThreadContextReadOptions,
  logger: Logger,
): Promise<ThreadContextResult> {
  if (!channel.isThread()) {
    return { status: 'not-a-thread' };
  }

  try {
    const fetchOptions = options.beforeMessageId
      ? { before: options.beforeMessageId, limit: maximumFetchedMessages }
      : { limit: maximumFetchedMessages };
    const [starter, recent] = await Promise.all([
      channel.fetchStarterMessage(),
      channel.messages.fetch(fetchOptions),
    ]);
    const conversation = buildThreadConversation(starter, recent.values(), options);
    if (!conversation.question) {
      return { status: 'empty' };
    }
    return {
      ...conversation,
      status: 'found',
    };
  } catch (error) {
    if (isForbidden(error)) {
      logger.warn({ threadId: channel.id }, 'Discord denied access to the thread history.');
      return { status: 'forbidden' };
    }
    logger.warn({ err: error, threadId: channel.id }, 'Unable to read the thread history.');
    return { status: 'error' };
  }
}

export function buildThreadConversation(
  starter: ThreadMessageSnapshot | null,
  messages: Iterable<ThreadMessageSnapshot>,
  options: ThreadContextReadOptions,
): Pick<ThreadContextResult, 'context' | 'images' | 'question'> {
  const snapshots = new Map<string, ThreadMessageSnapshot>();
  if (starter) {
    snapshots.set(starter.id, starter);
  }
  for (const message of messages) {
    snapshots.set(message.id, message);
  }

  const turns = [...snapshots.values()]
    .filter((message) => isBeforeInvocation(message, options))
    .map((message) => toTurn(message, options))
    .filter((turn): turn is ThreadTurn => Boolean(turn))
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const current = turns.findLast((turn) => turn.isHuman);
  if (!current) {
    return {};
  }

  const participantLabels = createParticipantLabels(turns, starter?.author.id);
  const rendered = new Map(
    turns.map((turn) => [turn.id, renderTurn(turn, starter?.author.id, participantLabels)]),
  );
  const selected = selectHistoryTurns(turns, starter?.id, current.id, rendered);
  const images = selectThreadImages(
    turns.find((turn) => turn.id === starter?.id),
    current,
  );
  return {
    context: selected
      .map((turn) => rendered.get(turn.id))
      .filter(Boolean)
      .join('\n\n'),
    ...(images.length > 0 ? { images } : {}),
    question:
      current.question ||
      'What does the attached image show about this issue in the Aspire application?',
  };
}

function isBeforeInvocation(
  message: ThreadMessageSnapshot,
  options: ThreadContextReadOptions,
): boolean {
  return (
    message.id !== options.beforeMessageId &&
    (options.beforeTimestamp === undefined || message.createdTimestamp < options.beforeTimestamp)
  );
}

function toTurn(
  message: ThreadMessageSnapshot,
  options: ThreadContextReadOptions,
): ThreadTurn | undefined {
  if (message.system) {
    return undefined;
  }
  const question = (message.cleanContent.trim() || message.content.trim()).trim();
  const images = message.attachments
    ? [...message.attachments.values()].filter(isPotentialImageAttachment)
    : [];
  if (!question && images.length === 0) {
    return undefined;
  }

  const isAssistant = message.author.bot && message.author.id === options.botUserId;
  if (message.author.bot && !isAssistant) {
    return undefined;
  }
  if (
    !message.author.bot &&
    question &&
    !evaluateQuestion(question, options.maxQuestionLength).isAllowed
  ) {
    return undefined;
  }

  const content = sanitizeForAgent(question).trim().slice(0, maximumTurnLength);
  if (!content && images.length === 0) {
    return undefined;
  }
  return {
    authorId: message.author.id,
    content,
    id: message.id,
    images,
    isAssistant,
    isHuman: !message.author.bot,
    question,
    timestamp: message.createdTimestamp,
  };
}

function createParticipantLabels(
  turns: readonly ThreadTurn[],
  originalPosterId: string | undefined,
): ReadonlyMap<string, number> {
  const labels = new Map<string, number>();
  for (const turn of turns) {
    if (turn.isHuman && turn.authorId !== originalPosterId && !labels.has(turn.authorId)) {
      labels.set(turn.authorId, labels.size + 1);
    }
  }
  return labels;
}

function renderTurn(
  turn: ThreadTurn,
  originalPosterId: string | undefined,
  participantLabels: ReadonlyMap<string, number>,
): string {
  const label = turn.isAssistant
    ? 'Previous assistant answer'
    : turn.authorId === originalPosterId
      ? 'Original poster'
      : `Participant ${String(participantLabels.get(turn.authorId) ?? 1)}`;
  const imageMarker =
    turn.images.length > 0
      ? `[${String(turn.images.length)} image${turn.images.length === 1 ? '' : 's'} attached]`
      : '';
  return `[${label}]\n${[turn.content, imageMarker].filter(Boolean).join('\n')}`;
}

function selectThreadImages(
  starter: ThreadTurn | undefined,
  current: ThreadTurn,
): readonly DiscordImageCandidate[] {
  const selected: DiscordImageCandidate[] = [];
  const add = (turn: ThreadTurn | undefined, source: DiscordImageSource): void => {
    for (const attachment of turn?.images ?? []) {
      selected.push({ attachment, explicit: false, source });
    }
  };

  add(current, 'latest thread turn');
  if (starter?.id !== current.id) {
    add(starter, 'thread starter');
  }
  return selected;
}

function selectHistoryTurns(
  turns: readonly ThreadTurn[],
  starterId: string | undefined,
  currentId: string,
  rendered: ReadonlyMap<string, string>,
): readonly ThreadTurn[] {
  const selected = new Set<string>();
  let length = 0;

  const add = (turn: ThreadTurn | undefined): void => {
    if (!turn || selected.has(turn.id) || selected.size >= maximumHistoryMessages) {
      return;
    }
    const value = rendered.get(turn.id);
    if (!value) {
      return;
    }
    const separatorLength = selected.size > 0 ? 2 : 0;
    if (length + separatorLength + value.length > THREAD_CONTEXT_MAX_LENGTH) {
      return;
    }
    selected.add(turn.id);
    length += separatorLength + value.length;
  };

  add(turns.find((turn) => turn.id === starterId));
  add(turns.find((turn) => turn.id === currentId));
  for (let index = turns.length - 1; index >= 0; index--) {
    add(turns[index]);
  }

  return turns.filter((turn) => selected.has(turn.id));
}

function isForbidden(error: unknown): boolean {
  return error instanceof DiscordAPIError && (error.status === 403 || error.code === 50_013);
}
