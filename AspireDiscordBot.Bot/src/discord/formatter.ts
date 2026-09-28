import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import type { GroundingDetailsMode } from '../config.js';
import type { GroundedAnswer } from '../domain.js';
import { redactSensitiveText } from '../safety.js';

const maximumMessageLength = 2_000;
const closingFence = '```';

export interface AnswerThread {
  readonly answerMessages: readonly [string, ...string[]];
  readonly detailMessages: readonly AnswerDetailMessage[];
}

export interface AnswerDetailMessage {
  readonly components?: readonly ActionRowBuilder<ButtonBuilder>[];
  readonly content: string;
}

export function buildAnswerThread(
  question: string,
  answer: GroundedAnswer,
  groundingDetailsMode: GroundingDetailsMode = 'collapsed',
): AnswerThread {
  if (answer.source === 'conversation') {
    const [first = 'Please clarify the request.', ...rest] = splitMarkdown(
      redactSensitiveText(answer.answer.trim()),
    );
    return { answerMessages: [first, ...rest], detailMessages: [] };
  }
  const answerSections = [
    `### ❓ ${truncate(escapeMarkdown(singleLine(redactSensitiveText(question))), 256)}`,
    answer.answer.trim(),
  ];
  const detailSections: string[] = [];
  let sourceComponents: readonly ActionRowBuilder<ButtonBuilder>[] | undefined;

  if (answer.isGrounded && answer.citations.length > 0) {
    const citations = answer.citations.slice(0, answer.source === 'github' ? 25 : 5);
    if (groundingDetailsMode === 'expanded') {
      const sources = citations
        .map((citation) =>
          isSafeSourceUrl(citation.url)
            ? `[${String(citation.number)}] [${truncate(sanitizeTitle(citation.title), 100)}](${citation.url})`
            : `[${String(citation.number)}] ${truncate(sanitizeTitle(citation.title), 100)} (source link unavailable)`,
        )
        .join('\n');
      detailSections.push(`**Grounded sources**\n${sources}`);
    } else if (groundingDetailsMode === 'collapsed') {
      const linkedCitations = citations.filter((citation) => isSafeSourceUrl(citation.url));
      if (linkedCitations.length === 0) {
        detailSections.push('-# Grounded source links unavailable');
      } else {
        detailSections.push(
          `-# ${String(linkedCitations.length)} grounded source${linkedCitations.length === 1 ? '' : 's'}`,
        );
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        for (let index = 0; index < linkedCitations.length; index += 5) {
          rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              linkedCitations.slice(index, index + 5).map((citation) =>
                new ButtonBuilder()
                  .setLabel(
                    `[${String(citation.number)}] ${truncate(singleLine(citation.title), 72)}`,
                  )
                  .setStyle(ButtonStyle.Link)
                  .setURL(citation.url),
              ),
            ),
          );
        }
        sourceComponents = rows;
      }
    }
  }

  if (answer.notices?.length) {
    detailSections.push(formatNotices(answer.notices));
  }

  detailSections.push(
    answer.source === 'github'
      ? answer.isGrounded
        ? '-# Live GitHub evidence from the configured Aspire repositories; see report coverage and limits.'
        : '-# GitHub lookup needs clarification or is unavailable; no documentation match is required.'
      : answer.isGrounded
        ? '-# Grounded in microsoft/aspire & aspire.dev'
        : '-# No matching coverage found in microsoft/aspire or aspire.dev',
  );

  const [firstAnswer = 'Sorry - I could not format that answer.', ...answerRest] = splitMarkdown(
    answerSections.filter(Boolean).join('\n\n'),
  );
  const [firstDetail = '-# Grounding details were unavailable.', ...detailRest] = splitMarkdown(
    detailSections.filter(Boolean).join('\n\n'),
  );
  return {
    answerMessages: [firstAnswer, ...answerRest],
    detailMessages: [
      {
        ...(sourceComponents ? { components: sourceComponents } : {}),
        content: firstDetail,
      },
      ...detailRest.map((content) => ({ content })),
    ],
  };
}

function formatNotices(notices: readonly string[]): string {
  const unique = [...new Set(notices)];
  const displayed = unique
    .slice(0, 5)
    .map((notice) => `-# Context note: ${truncate(singleLine(notice), 240)}`);
  const omitted = unique.length - displayed.length;
  if (omitted > 0) {
    displayed.push(
      `-# Context note: ${String(omitted)} additional context limitation${omitted === 1 ? ' was' : 's were'} also applied.`,
    );
  }
  return displayed.join('\n');
}

function sanitizeTitle(value: string): string {
  return value.replaceAll('[', '(').replaceAll(']', ')');
}

function isSafeSourceUrl(value: string): boolean {
  if (value.length > 512) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function splitMarkdown(value: string): string[] {
  const chunks: string[] = [];
  let remaining = value.trim();
  let openFence: string | undefined;

  while (remaining) {
    const prefix = openFence ? `${openFence}\n` : '';
    const available = maximumMessageLength - prefix.length - closingFence.length - 1;
    const splitAt = preferredSplit(remaining, available);
    const body = remaining.slice(0, splitAt).trimEnd();
    const nextOpenFence = fenceAfter(body, openFence);
    const suffix = nextOpenFence ? `\n${closingFence}` : '';
    chunks.push(`${prefix}${body}${suffix}`);
    remaining = consumeSeparator(remaining.slice(splitAt));
    openFence = nextOpenFence;
  }

  return chunks;
}

function preferredSplit(value: string, maximum: number): number {
  if (value.length <= maximum) {
    return value.length;
  }

  const minimum = Math.floor(maximum / 2);
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = value.lastIndexOf(separator, maximum);
    if (index >= minimum) {
      return index;
    }
  }
  return maximum;
}

function consumeSeparator(value: string): string {
  if (value.startsWith('\r\n\r\n')) {
    return value.slice(4);
  }
  if (value.startsWith('\n\n')) {
    return value.slice(2);
  }
  if (value.startsWith('\r\n')) {
    return value.slice(2);
  }
  if (value.startsWith('\n') || value.startsWith(' ')) {
    return value.slice(1);
  }
  return value;
}

function fenceAfter(value: string, current: string | undefined): string | undefined {
  let openFence = current;
  for (const line of value.split(/\r?\n/gu)) {
    const match = /^\s*```([\w+.-]{0,40})\s*$/u.exec(line);
    if (!match) {
      continue;
    }
    openFence = openFence ? undefined : `\`\`\`${match[1] ?? ''}`;
  }
  return openFence;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
