export interface Citation {
  readonly number: number;
  readonly repo: string;
  readonly title: string;
  readonly url: string;
}

export interface GroundedAnswer {
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly isGrounded: boolean;
  readonly notices?: readonly string[];
  readonly topScore: number;
  readonly source?: 'github' | 'conversation';
  readonly requiresReply?: boolean;
  readonly pendingIssue?: PendingIssueFields;
}

export type AnswerProgressPhase =
  'checking-links' | 'reading' | 'researching' | 'searching-docs' | 'writing';

export interface AnswerProgress {
  readonly phase: AnswerProgressPhase;
}

export type AnswerProgressHandler = (progress: AnswerProgress) => Promise<void> | void;

export interface AnswerImage {
  readonly data: string;
  readonly displayName: string;
  readonly mimeType: 'image/jpeg' | 'image/png';
}

export interface AnswerDocument {
  readonly content: string;
  readonly displayName: string;
  readonly source: string;
}

export interface PendingIssueFields {
  readonly repository?: string;
  readonly title?: string;
  readonly body?: string;
}

export interface PreparedIssueFields {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}

export interface ConversationContext {
  readonly allowIssueDraft?: boolean;
  readonly documents?: readonly AnswerDocument[];
  readonly history?: string;
  readonly sourceContext?: string;
  readonly referencedQuestion?: string;
  readonly referenceSource?: 'forwarded' | 'reply' | 'thread';
  readonly images?: readonly AnswerImage[];
  readonly notices?: readonly string[];
  readonly questionSource?: string;
  readonly pendingIssue?: PendingIssueFields;
  readonly prepareIssueDraft?: (
    input: PreparedIssueFields,
    signal?: AbortSignal,
  ) => Promise<{ readonly draftId: string; readonly version: number }>;
}

export interface VectorSearchResult {
  readonly content: string;
  readonly heading?: string;
  readonly path: string;
  readonly repo: string;
  readonly score: number;
  readonly title: string;
  readonly url: string;
}

export interface AnswerService {
  answer(
    question: string,
    signal?: AbortSignal,
    onProgress?: AnswerProgressHandler,
    conversation?: ConversationContext,
  ): Promise<GroundedAnswer>;
}
