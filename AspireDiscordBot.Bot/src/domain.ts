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
  readonly topScore: number;
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

export interface ConversationContext {
  readonly history?: string;
  readonly images?: readonly AnswerImage[];
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
