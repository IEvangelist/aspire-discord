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
  answer(question: string, signal?: AbortSignal): Promise<GroundedAnswer>;
}
