import { escapeMarkdown } from 'discord.js';
import type { GroundedAnswer } from '../domain.js';
import { redactSensitiveText } from '../safety.js';

const maximumMessageLength = 2_000;
const closingFence = '```';

export interface AnswerThread {
  readonly answerMessages: readonly [string, ...string[]];
  readonly detailMessages: readonly [string, ...string[]];
}

export function buildAnswerThread(question: string, answer: GroundedAnswer): AnswerThread {
  const answerSections = [
    `### ❓ ${truncate(escapeMarkdown(singleLine(redactSensitiveText(question))), 256)}`,
    answer.answer.trim(),
  ];
  const detailSections: string[] = [];

  if (answer.isGrounded && answer.citations.length > 0) {
    const sources = answer.citations
      .slice(0, 5)
      .map(
        (citation) =>
          `[${String(citation.number)}] [${truncate(sanitizeTitle(citation.title), 100)}](${citation.url})`,
      )
      .join('\n');
    detailSections.push(`**Grounded sources**\n${sources}`);
  }

  if (answer.notices?.length) {
    detailSections.push(formatNotices(answer.notices));
  }

  detailSections.push(
    answer.isGrounded
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
    detailMessages: [firstDetail, ...detailRest],
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
