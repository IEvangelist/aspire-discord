import { DiscordAPIError, type AnyThreadChannel, type TextBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import { evaluateQuestion, sanitizeForAgent, truncateAtGrapheme } from '../safety.js';
import {
  isPotentialImageAttachment,
  type DiscordAttachmentSnapshot,
  type DiscordImageCandidate,
  type DiscordImageSource,
} from './image-context.js';
import { isPotentialTextAttachment, type DiscordTextCandidate } from './text-context.js';

const maximumFetchedMessages = 50;
const maximumHistoryMessages = 20;
const maximumTurnLength = 1_200;

export const THREAD_CONTEXT_MAX_LENGTH = 8_000;

export type ThreadContextStatus = 'empty' | 'error' | 'forbidden' | 'found' | 'not-a-thread';

export interface ThreadContextResult {
  readonly context?: string;
  readonly files?: readonly DiscordTextCandidate[];
  readonly images?: readonly DiscordImageCandidate[];
  readonly messageIds?: ReadonlySet<string>;
  readonly notices?: readonly string[];
  readonly question?: string;
  readonly questionRequiresAttachment?: boolean;
  readonly referenceQuestion?: string;
  readonly starterQuestion?: string;
  readonly status: ThreadContextStatus;
}

export interface ThreadContextReadOptions {
  readonly beforeMessageId?: string;
  readonly beforeTimestamp?: number;
  readonly botUserId?: string;
  readonly includeOlderHistory?: boolean;
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
  readonly embeds?: readonly DiscordEmbedSnapshot[];
  readonly id: string;
  readonly system?: boolean;
}

export interface ThreadMetadata {
  readonly tags?: readonly string[];
  readonly title?: string;
}

export interface DiscordEmbedSnapshot {
  readonly data: {
    readonly type?: string;
  };
  readonly image: DiscordEmbedImageSnapshot | null;
  readonly thumbnail: DiscordEmbedImageSnapshot | null;
}

interface DiscordEmbedImageSnapshot {
  readonly height?: number;
  readonly proxyURL?: string;
  readonly url: string;
  readonly width?: number;
}

interface ThreadTurn {
  readonly authorId: string;
  readonly content: string;
  readonly id: string;
  readonly files: readonly DiscordAttachmentSnapshot[];
  readonly images: readonly DiscordAttachmentSnapshot[];
  readonly isAssistant: boolean;
  readonly isHuman: boolean;
  readonly notices: readonly string[];
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
    const messages = [...recent.values()];
    let historyIsPartial = false;
    let olderHistoryFailed = false;
    if (options.includeOlderHistory) {
      let page = recent;
      for (let index = 1; index < 4 && page.size === maximumFetchedMessages; index++) {
        const oldest = [...page.values()].sort(
          (left, right) =>
            left.createdTimestamp - right.createdTimestamp ||
            left.id.length - right.id.length ||
            left.id.localeCompare(right.id),
        )[0];
        if (!oldest) break;
        try {
          page = await channel.messages.fetch({ before: oldest.id, limit: maximumFetchedMessages });
        } catch (error) {
          if (isForbidden(error)) throw error;
          logger.warn(
            { errorType: error instanceof Error ? error.name : 'Error', threadId: channel.id },
            'Unable to read older Discord thread pages.',
          );
          olderHistoryFailed = true;
          historyIsPartial = true;
          break;
        }
        messages.push(...page.values());
      }
      historyIsPartial ||= page.size === maximumFetchedMessages;
    } else {
      historyIsPartial = recent.size === maximumFetchedMessages;
    }
    const conversation = buildThreadConversation(
      starter,
      messages,
      options,
      readThreadMetadata(channel),
    );
    if (!conversation.question) {
      return { ...conversation, status: 'empty' };
    }
    return {
      ...conversation,
      ...(historyIsPartial
        ? {
            notices: [
              ...(conversation.notices ?? []),
              olderHistoryFailed
                ? 'Older thread history could not be read; earlier replies may be missing.'
                : 'This thread has more history than was read; earlier replies may be missing.',
            ],
          }
        : {}),
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
  metadata: ThreadMetadata = {},
): Omit<ThreadContextResult, 'status'> {
  const snapshots = new Map<string, ThreadMessageSnapshot>();
  if (starter) {
    snapshots.set(starter.id, starter);
  }
  for (const message of messages) {
    snapshots.set(message.id, message);
  }

  const ordered = [...snapshots.values()]
    .filter((message) => isBeforeInvocation(message, options))
    .filter((message) => !message.system)
    .sort(
      (left, right) =>
        left.createdTimestamp - right.createdTimestamp || left.id.localeCompare(right.id),
    );
  const latestHumanMessage = ordered.findLast(
    (message) => !message.author.bot && hasMessageInput(message),
  );
  const turns = ordered
    .map((message) => toTurn(message, options))
    .filter((turn): turn is ThreadTurn => Boolean(turn));
  const latestTurn = latestHumanMessage
    ? turns.find((turn) => turn.id === latestHumanMessage.id)
    : undefined;
  const contextCurrent = latestTurn ?? turns.findLast((turn) => turn.isHuman);
  const title = metadata.title?.trim() ?? '';
  if (!latestHumanMessage && !title) {
    return {};
  }

  const participantLabels = createParticipantLabels(turns, starter?.author.id);
  const rendered = new Map(
    turns.map((turn) => [turn.id, renderTurn(turn, starter?.author.id, participantLabels)]),
  );
  const metadataContext = renderThreadMetadata(metadata);
  const selected = selectHistoryTurns(
    turns,
    starter?.id,
    contextCurrent?.id,
    rendered,
    metadataContext.length + (metadataContext ? 2 : 0),
  );
  const starterTurn = turns.find((turn) => turn.id === starter?.id);
  const images = latestTurn ? selectThreadImages(starterTurn, latestTurn) : [];
  const files = latestTurn ? selectThreadFiles(starterTurn, latestTurn) : [];
  const notices = latestTurn
    ? [...new Set([...latestTurn.notices, ...(starterTurn?.notices ?? [])])]
    : [];
  if (selected.length < turns.length) {
    notices.push('Thread context was condensed; some older messages are not included.');
  }
  const latestQuestion = latestHumanMessage ? messageText(latestHumanMessage) : '';
  const referenceQuestion = contextCurrent?.isHuman ? contextCurrent.question : '';
  const starterQuestion = starterTurn?.isHuman ? starterTurn.question : '';
  const questionRequiresAttachment =
    !latestQuestion &&
    Boolean(latestTurn && (latestTurn.images.length > 0 || latestTurn.files.length > 0));
  const question =
    latestQuestion ||
    (questionRequiresAttachment
      ? 'What does the attached context show about this issue in the Aspire application?'
      : latestHumanMessage
        ? ''
        : title);
  return {
    context: [
      metadataContext,
      selected
        .map((turn) => rendered.get(turn.id))
        .filter(Boolean)
        .join('\n\n'),
    ]
      .filter(Boolean)
      .join('\n\n'),
    ...(files.length > 0 ? { files } : {}),
    ...(images.length > 0 ? { images } : {}),
    messageIds: new Set(selected.map((turn) => turn.id)),
    ...(notices.length > 0 ? { notices } : {}),
    ...(question ? { question } : {}),
    ...(questionRequiresAttachment ? { questionRequiresAttachment: true } : {}),
    ...(referenceQuestion ? { referenceQuestion } : {}),
    ...(starterQuestion ? { starterQuestion } : {}),
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
  const images = extractMessageImages(message);
  const files = extractMessageFiles(message);
  const notices = unsupportedAttachmentNotices(message);
  if (!question && images.length === 0 && files.length === 0 && notices.length === 0) {
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

  const content = truncateAtGrapheme(sanitizeForAgent(question).trim(), maximumTurnLength);
  if (!content && images.length === 0 && files.length === 0 && notices.length === 0) {
    return undefined;
  }
  return {
    authorId: message.author.id,
    content,
    files,
    id: message.id,
    images,
    isAssistant,
    isHuman: !message.author.bot,
    notices,
    question,
    timestamp: message.createdTimestamp,
  };
}

export function extractMessageImages(
  message: ThreadMessageSnapshot,
): readonly DiscordAttachmentSnapshot[] {
  const attachments = message.attachments
    ? sortAttachments([...message.attachments.values()].filter(isPotentialImageAttachment))
    : [];
  const inlineImages = (message.embeds ?? []).flatMap((embed, index) => {
    const image = embed.thumbnail?.proxyURL
      ? embed.thumbnail
      : embed.image?.proxyURL
        ? embed.image
        : undefined;
    if (embed.data.type !== 'image' || !image?.proxyURL) {
      return [];
    }
    return [
      {
        contentType: null,
        height: image.height ?? null,
        id: `embed-${message.id}-${String(index)}`,
        inline: true,
        name: 'inline-image',
        size: 0,
        url: image.proxyURL,
        width: image.width ?? null,
      },
    ];
  });
  return [...attachments, ...inlineImages];
}

export function extractMessageFiles(
  message: ThreadMessageSnapshot,
): readonly DiscordAttachmentSnapshot[] {
  return message.attachments
    ? sortAttachments(
        [...message.attachments.values()].filter(
          (attachment) =>
            !isPotentialImageAttachment(attachment) && isPotentialTextAttachment(attachment),
        ),
      )
    : [];
}

function sortAttachments(
  attachments: readonly DiscordAttachmentSnapshot[],
): readonly DiscordAttachmentSnapshot[] {
  return [...attachments].sort(
    (left, right) =>
      left.id.length - right.id.length ||
      left.id.localeCompare(right.id, 'en-US', { numeric: true }),
  );
}

export function unsupportedAttachmentNotices(message: ThreadMessageSnapshot): readonly string[] {
  if (!message.attachments) {
    return [];
  }
  const notices = [...message.attachments.values()].flatMap((attachment) => {
    if (isPotentialImageAttachment(attachment) || isPotentialTextAttachment(attachment)) {
      return [];
    }
    const contentType = attachment.contentType?.toLocaleLowerCase('en-US') ?? '';
    if (contentType.startsWith('audio/')) {
      return ['Audio attachments are not transcribed; include a text transcript for analysis.'];
    }
    if (contentType.startsWith('video/')) {
      return [
        'Video attachments are not analyzed; attach a screenshot or text transcript instead.',
      ];
    }
    return ['An unsupported attachment was omitted from the answer context.'];
  });
  return [...new Set(notices)];
}

function hasMessageInput(message: ThreadMessageSnapshot): boolean {
  return (
    Boolean(messageText(message)) ||
    extractMessageImages(message).length > 0 ||
    extractMessageFiles(message).length > 0 ||
    unsupportedAttachmentNotices(message).length > 0
  );
}

function messageText(message: ThreadMessageSnapshot): string {
  return (message.cleanContent.trim() || message.content.trim()).trim();
}

function readThreadMetadata(channel: AnyThreadChannel): ThreadMetadata {
  const parent = channel.parent;
  const tags =
    parent?.isThreadOnly() === true
      ? channel.appliedTags
          .map((id) => parent.availableTags.find((tag) => tag.id === id)?.name)
          .filter((name): name is string => Boolean(name))
      : [];
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(channel.name.trim() ? { title: channel.name.trim() } : {}),
  };
}

function renderThreadMetadata(metadata: ThreadMetadata): string {
  const title = metadata.title?.trim();
  const tags = metadata.tags?.map((tag) => sanitizeForAgent(tag).trim()).filter(Boolean) ?? [];
  return [
    title ? `[Thread title]\n${truncateAtGrapheme(sanitizeForAgent(title), 200)}` : '',
    tags.length > 0 ? `[Forum tags]\n${tags.slice(0, 5).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
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
  const fileMarker =
    turn.files.length > 0
      ? `[${String(turn.files.length)} text file${turn.files.length === 1 ? '' : 's'} attached]`
      : '';
  return `[${label}]\n${[turn.content, imageMarker, fileMarker].filter(Boolean).join('\n')}`;
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

function selectThreadFiles(
  starter: ThreadTurn | undefined,
  current: ThreadTurn,
): readonly DiscordTextCandidate[] {
  const selected: DiscordTextCandidate[] = [];
  const add = (turn: ThreadTurn | undefined, source: DiscordImageSource): void => {
    for (const attachment of turn?.files ?? []) {
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
  currentId: string | undefined,
  rendered: ReadonlyMap<string, string>,
  initialLength = 0,
): readonly ThreadTurn[] {
  const selected = new Set<string>();
  let length = initialLength;

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
