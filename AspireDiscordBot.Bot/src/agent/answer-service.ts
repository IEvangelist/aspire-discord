import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { CitationRegistry } from '../citations.js';
import type { AnswerService, GroundedAnswer, VectorSearchResult } from '../domain.js';
import { withAgentSpan } from '../genai-telemetry.js';
import { buildAgentPrompt, NOT_COVERED_MESSAGE } from '../prompts.js';
import { evaluateQuestion, isAnswerSafe } from '../safety.js';
import type { Tool } from '@github/copilot-sdk';
import type { EmbeddingModel } from './embeddings.js';
import { createGroundingTools } from './grounding-tools.js';
import { ToolBudget } from './tool-budget.js';

export interface AgentRuntime {
  complete(
    prompt: string,
    // The SDK models heterogeneous tool collections as Tool<any>[].
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: readonly Tool<any>[],
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface GitHubToolProvider {
  // The SDK models heterogeneous tool collections as Tool<any>[].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createTools(citations: CitationRegistry, budget: ToolBudget): readonly Tool<any>[];
}

export interface RetrievalStore {
  searchApi(
    vector: readonly number[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]>;
  searchDocs(
    vector: readonly number[],
    limit: number,
    scoreThreshold?: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]>;
}

export class GroundedAnswerService implements AnswerService {
  public constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingModel,
    private readonly qdrant: RetrievalStore,
    private readonly copilot: AgentRuntime,
    private readonly githubMcp: GitHubToolProvider,
    private readonly logger: Logger,
  ) {}

  public async answer(question: string, signal?: AbortSignal): Promise<GroundedAnswer> {
    return await withAgentSpan(
      {
        maxOutputTokens: this.config.ai.maxOutputTokens,
        model: this.config.ai.chatModel,
        provider: this.config.ai.provider,
        reasoningLevel: this.config.ai.reasoningEffort,
      },
      async (span) => {
        const trimmed = question.trim();
        const verdict = evaluateQuestion(trimmed, this.config.safety.maxQuestionLength);
        if (!verdict.isAllowed) {
          span.setAttribute('gen_ai.agent.outcome', `blocked:${verdict.category}`);
          this.logger.warn(
            { safetyCategory: verdict.category, reason: verdict.reason },
            'Blocked Discord question.',
          );
          return notFound(
            verdict.category === 'empty' || verdict.category === 'too-long'
              ? 'Please ask a clear Aspire question (up to a few sentences).'
              : 'I can only help with legitimate Aspire questions grounded in official sources.',
          );
        }

        const vector = await this.embeddings.embed(trimmed, signal);
        const minimumScore = Math.max(
          this.config.retrieval.minScore,
          this.config.safety.minTopicScore,
        );
        const seed = await this.qdrant.searchDocs(
          vector,
          this.config.retrieval.topK,
          minimumScore,
          signal,
        );
        const topScore = seed[0]?.score ?? 0;
        if (seed.length === 0) {
          span.setAttribute('gen_ai.agent.outcome', 'off_topic');
          return notFound(
            "I couldn't find relevant Aspire documentation for that question. Try rephrasing it or check https://aspire.dev.",
            topScore,
          );
        }

        const citations = new CitationRegistry();
        const budget = new ToolBudget(this.config.agent.maxToolCalls);
        const tools = [
          ...createGroundingTools({
            budget,
            citations,
            config: this.config.retrieval,
            embeddings: this.embeddings,
            qdrant: this.qdrant,
          }),
          ...this.githubMcp.createTools(citations, budget),
        ];
        const toolNames = new Set(tools.map((tool) => tool.name));
        const prompt = buildAgentPrompt(trimmed, citations.formatResults(seed), toolNames);
        const answer = await this.copilot.complete(prompt, tools, signal);

        if (!answer || answer.toLocaleUpperCase('en-US').includes('NOT_COVERED')) {
          span.setAttribute('gen_ai.agent.outcome', 'not_covered');
          return notFound(NOT_COVERED_MESSAGE, topScore);
        }
        if (!isAnswerSafe(answer)) {
          span.setAttribute('gen_ai.agent.outcome', 'output_blocked');
          this.logger.warn('Suppressed an answer that failed output validation.');
          return notFound(
            'I could not produce a safe, grounded answer. Please rephrase the Aspire question.',
            topScore,
          );
        }

        const selected = citations.citedBy(answer);
        span.setAttribute('gen_ai.agent.citation_count', selected.length);
        span.setAttribute('gen_ai.agent.outcome', 'answered');
        return {
          answer,
          citations: selected,
          isGrounded: true,
          topScore,
        };
      },
    );
  }
}

function notFound(answer: string, topScore = 0): GroundedAnswer {
  return {
    answer,
    citations: [],
    isGrounded: false,
    topScore,
  };
}
