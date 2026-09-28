import type { GroundedAnswer, PendingIssueFields } from '../domain.js';
import { redactSensitiveText, truncateAtGrapheme } from '../safety.js';

export interface ConversationActor {
  readonly userId: string;
  readonly guildId: string | null;
  readonly channelId: string;
}

export interface PendingConversation {
  readonly history: string;
  readonly sourceContext?: string;
  readonly requiresReply: boolean;
  readonly pendingIssue?: PendingIssueFields;
}

interface Entry extends PendingConversation {
  readonly expiresAt: number;
}

export function conversationKey(actor: ConversationActor): string {
  return JSON.stringify([actor.guildId, actor.channelId, actor.userId]);
}

export class ConversationState {
  readonly #entries = new Map<string, Entry>();
  public constructor(
    private readonly now: () => number = Date.now,
    private readonly lifetimeMs = 10 * 60_000,
    private readonly maximumEntries = 500,
  ) {}

  public get(actor: ConversationActor): PendingConversation | undefined {
    const key = conversationKey(actor);
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt > this.now()) {
      return {
        history: entry.history,
        ...(entry.sourceContext ? { sourceContext: entry.sourceContext } : {}),
        requiresReply: entry.requiresReply,
        ...(entry.pendingIssue ? { pendingIssue: { ...entry.pendingIssue } } : {}),
      };
    }
    this.#entries.delete(key);
    return undefined;
  }

  public remember(
    actor: ConversationActor,
    question: string,
    answer: GroundedAnswer,
    sourceContext?: string,
  ): void {
    const previous = this.get(actor);
    const latest = `Requester: ${redactSensitiveText(question)}\nAspirey: ${redactSensitiveText(answer.answer)}`;
    const history = truncateAtGrapheme(
      [previous?.history, latest].filter(Boolean).join('\n\n').slice(-8_000),
      8_000,
    );
    const key = conversationKey(actor);
    for (const [candidate, entry] of this.#entries) {
      if (entry.expiresAt <= this.now()) this.#entries.delete(candidate);
    }
    this.#entries.delete(key);
    this.#entries.set(key, {
      history,
      requiresReply: answer.requiresReply === true,
      expiresAt: this.now() + this.lifetimeMs,
      ...(answer.pendingIssue ? { pendingIssue: { ...answer.pendingIssue } } : {}),
      ...((answer.requiresReply || answer.pendingIssue) &&
      (sourceContext || previous?.sourceContext)
        ? {
            sourceContext: truncateAtGrapheme(
              redactSensitiveText(sourceContext || previous?.sourceContext || ''),
              8_000,
            ),
          }
        : {}),
    });
    while (this.#entries.size > this.maximumEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  public clear(actor: ConversationActor): void {
    this.#entries.delete(conversationKey(actor));
  }
}

export function combineSourceContext(previous = '', current = ''): string {
  if (!previous || current.includes(previous)) return truncateAtGrapheme(current, 8_000);
  if (!current || previous.includes(current)) return truncateAtGrapheme(previous, 8_000);
  return truncateAtGrapheme(`${previous.slice(0, 4_000)}\n\n${current.slice(-3_998)}`, 8_000);
}
