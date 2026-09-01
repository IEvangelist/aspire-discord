import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { CitationRegistry } from '../citations.js';
import type {
  AnswerDocument,
  AnswerImage,
  AnswerProgressHandler,
  AnswerService,
  ConversationContext,
  GroundedAnswer,
  VectorSearchResult,
} from '../domain.js';
import { withAgentSpan } from '../genai-telemetry.js';
import { buildAgentPrompt, NOT_COVERED_MESSAGE } from '../prompts.js';
import { evaluateQuestion, isAnswerSafe, sanitizeForAgent, truncateAtGrapheme } from '../safety.js';
import type { Tool } from '@github/copilot-sdk';
import type { EmbeddingModel } from './embeddings.js';
import { createGroundingTools } from './grounding-tools.js';
import { ImageCapabilityError } from './image-capability.js';
import type { QuestionContextProvider, QuestionContextResult } from './question-context.js';
import { prioritizeCurrentDocumentation } from './retrieval-freshness.js';
import { ToolBudget } from './tool-budget.js';

export interface AgentRuntime {
  complete(
    prompt: string,
    // The SDK models heterogeneous tool collections as Tool<any>[].
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: readonly Tool<any>[],
    signal?: AbortSignal,
    onProgress?: AnswerProgressHandler,
    images?: readonly AnswerImage[],
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
    private readonly questionContext?: QuestionContextProvider,
  ) {}

  public async answer(
    question: string,
    signal?: AbortSignal,
    onProgress?: AnswerProgressHandler,
    conversation?: ConversationContext,
  ): Promise<GroundedAnswer> {
    const started = performance.now();
    try {
      const result = await withAgentSpan(
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

          const agentQuestion = sanitizeForAgent(trimmed);
          const conversationHistory = truncateAtGrapheme(
            sanitizeForAgent(conversation?.history?.trim() ?? ''),
            8_000,
          );
          const documents = boundDocuments(
            conversation?.documents ?? [],
            this.config.textContext.maxFiles,
            this.config.textContext.maxCharacters,
          );
          const documentContext = truncateAtGrapheme(
            documents
              .map((document) => `${document.displayName}\n${document.content}`)
              .join('\n\n'),
            this.config.textContext.maxCharacters,
          );
          const images = (conversation?.images ?? []).slice(0, this.config.imageContext.maxImages);
          span.setAttribute('gen_ai.agent.document_count', documents.length);
          span.setAttribute('gen_ai.agent.image_count', images.length);
          span.setAttribute('gen_ai.agent.notice_count', conversation?.notices?.length ?? 0);
          if (conversation?.questionSource) {
            span.setAttribute('gen_ai.agent.question_source', conversation.questionSource);
          }
          const citations = new CitationRegistry();
          const budget = new ToolBudget(this.config.agent.maxToolCalls);
          let linked: QuestionContextResult = {
            context: '',
            liveRelease: 'not-requested',
            resolvedCount: 0,
            searchText: '',
            topicEvidenceCount: 0,
          };
          const observationContext = [conversationHistory, documentContext]
            .filter(Boolean)
            .join('\n\n');
          if (this.questionContext?.shouldResolve(trimmed, observationContext)) {
            await reportProgress(onProgress, 'checking-links', this.logger);
            linked = await this.questionContext.resolve(
              trimmed,
              citations,
              budget,
              signal,
              observationContext,
            );
            span.setAttribute('gen_ai.agent.link_context_count', linked.resolvedCount);
            span.setAttribute('gen_ai.agent.link_topic_evidence_count', linked.topicEvidenceCount);
            if (linked.liveRelease === 'unavailable') {
              span.setAttribute('gen_ai.agent.outcome', 'live_release_unavailable');
              return notFound(
                "I couldn't verify the current stable Aspire release from GitHub right now. Please try again shortly.",
              );
            }
          }

          await reportProgress(onProgress, 'searching-docs', this.logger);
          const retrievalHistory = observationContext.slice(-6_000);
          const retrievalQuery = [agentQuestion, linked.searchText, retrievalHistory]
            .filter(Boolean)
            .join('\n')
            .slice(0, 4_000);
          const vector = await this.embeddings.embed(retrievalQuery, signal);
          const minimumScore = Math.max(
            this.config.retrieval.minScore,
            this.config.safety.minTopicScore,
          );
          const candidates = await this.qdrant.searchDocs(
            vector,
            this.config.retrieval.topK * 3,
            minimumScore,
            signal,
          );
          const seed = prioritizeCurrentDocumentation(
            candidates,
            [agentQuestion, retrievalHistory].filter(Boolean).join('\n'),
            this.config.retrieval.topK,
          );
          const topScore = seed[0]?.score ?? 0;
          if (seed.length === 0 && linked.topicEvidenceCount === 0 && images.length === 0) {
            span.setAttribute('gen_ai.agent.outcome', 'off_topic');
            return notFound(
              "I couldn't find relevant Aspire documentation for that question. Try rephrasing it or check https://aspire.dev.",
              topScore,
            );
          }

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
          const initialContext = [linked.context, citations.formatResults(seed)]
            .filter(Boolean)
            .join('\n\n');
          const prompt = buildAgentPrompt(
            trimmed,
            initialContext,
            toolNames,
            conversationHistory,
            images.length,
            documents,
          );
          await reportProgress(onProgress, 'researching', this.logger);
          let answer;
          try {
            answer =
              images.length > 0
                ? await this.copilot.complete(prompt, tools, signal, onProgress, images)
                : await this.copilot.complete(prompt, tools, signal, onProgress);
          } catch (error) {
            if (error instanceof ImageCapabilityError) {
              span.setAttribute('gen_ai.agent.outcome', 'image_model_unsupported');
              return notFound(error.userMessage, topScore);
            }
            throw error;
          }

          if (!answer || answer.toLocaleUpperCase('en-US').includes('NOT_COVERED')) {
            if (linked.latestRelease) {
              answer = exactLatestReleaseAnswer(linked.latestRelease);
            } else {
              span.setAttribute('gen_ai.agent.outcome', 'not_covered');
              return notFound(NOT_COVERED_MESSAGE, topScore);
            }
          }
          if (!isAnswerSafe(answer)) {
            span.setAttribute('gen_ai.agent.outcome', 'output_blocked');
            this.logger.warn('Suppressed an answer that failed output validation.');
            return notFound(
              'I could not produce a safe, grounded answer. Please rephrase the Aspire question.',
              topScore,
            );
          }
          if (linked.latestRelease && !answer.includes(linked.latestRelease.version)) {
            answer = exactLatestReleaseAnswer(linked.latestRelease);
            span.setAttribute('gen_ai.agent.release_answer_corrected', true);
          }

          const selected = citations.citedBy(answer, images.length === 0);
          if (images.length > 0 && selected.length === 0) {
            span.setAttribute('gen_ai.agent.outcome', 'image_answer_ungrounded');
            return notFound(
              "I could inspect the image, but I couldn't verify an answer from official Aspire sources.",
              topScore,
            );
          }
          span.setAttribute('gen_ai.agent.citation_count', selected.length);
          span.setAttribute('gen_ai.agent.outcome', 'answered');
          span.setAttribute('gen_ai.agent.tool_call_count', budget.used);
          return {
            answer,
            citations: selected,
            isGrounded: true,
            topScore,
          };
        },
      );
      this.logger.info(
        {
          citationCount: result.citations.length,
          durationMilliseconds: Math.round(performance.now() - started),
          grounded: result.isGrounded,
          topScore: result.topScore,
        },
        'Answer pipeline completed.',
      );
      const notices = [...new Set(conversation?.notices ?? [])];
      return notices.length > 0 ? { ...result, notices } : result;
    } catch (error) {
      this.logger.warn(
        {
          durationMilliseconds: Math.round(performance.now() - started),
          errorType: error instanceof Error ? error.name : 'Error',
        },
        'Answer pipeline failed.',
      );
      throw error;
    }
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

function exactLatestReleaseAnswer(release: {
  readonly citationNumber: number;
  readonly version: string;
}): string {
  return `The latest stable Aspire release is **${release.version}**. [${String(release.citationNumber)}]`;
}

function boundDocuments(
  documents: readonly AnswerDocument[],
  maximumFiles: number,
  maximumCharacters: number,
): readonly AnswerDocument[] {
  const selected: AnswerDocument[] = [];
  let remaining = maximumCharacters;
  for (const document of documents.slice(0, maximumFiles)) {
    if (remaining <= 0) {
      break;
    }
    const content = truncateAtGrapheme(sanitizeForAgent(document.content), remaining);
    if (!content) {
      continue;
    }
    selected.push({
      content,
      displayName: truncateAtGrapheme(sanitizeForAgent(document.displayName), 100),
      source: sanitizeForAgent(document.source),
    });
    remaining -= content.length;
  }
  return selected;
}

async function reportProgress(
  handler: AnswerProgressHandler | undefined,
  phase: Parameters<AnswerProgressHandler>[0]['phase'],
  logger: Logger,
): Promise<void> {
  if (!handler) {
    return;
  }
  try {
    await handler({ phase });
  } catch (error) {
    logger.debug(
      { errorType: error instanceof Error ? error.name : 'Error', phase },
      'Could not publish answer progress.',
    );
  }
}
