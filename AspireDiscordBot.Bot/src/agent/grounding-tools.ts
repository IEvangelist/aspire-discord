import { defineTool, type Tool } from '@github/copilot-sdk';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { CitationRegistry } from '../citations.js';
import type { EmbeddingModel } from './embeddings.js';
import type { RetrievalStore } from './answer-service.js';
import { prioritizeCurrentDocumentation } from './retrieval-freshness.js';
import type { ToolBudget } from './tool-budget.js';
import { sanitizeForAgent } from '../safety.js';

const queryParameters = z.strictObject({
  query: z.string().trim().min(1).max(600),
});

export function createGroundingTools(
  dependencies: {
    readonly budget: ToolBudget;
    readonly citations: CitationRegistry;
    readonly config: AppConfig['retrieval'];
    readonly embeddings: EmbeddingModel;
    readonly qdrant: RetrievalStore;
    readonly signal?: AbortSignal;
  },
  // The SDK models heterogeneous tool collections as Tool<any>[].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): readonly Tool<any>[] {
  const { budget, citations, config, embeddings, qdrant, signal } = dependencies;

  return [
    defineTool('search_docs', {
      description:
        'Search official Aspire documentation for focused evidence. Call repeatedly with specific queries for multi-part questions.',
      parameters: queryParameters,
      skipPermission: true,
      defer: 'never',
      handler: async (input) => {
        signal?.throwIfAborted();
        const { query } = queryParameters.parse(input);
        return await budget.invoke('search_docs', async () => {
          signal?.throwIfAborted();
          const vector = await embeddings.embed(sanitizeForAgent(query), signal);
          signal?.throwIfAborted();
          const candidates = await qdrant.searchDocs(
            vector,
            config.resultsPerTool * 3,
            undefined,
            signal,
          );
          signal?.throwIfAborted();
          const results = prioritizeCurrentDocumentation(candidates, query, config.resultsPerTool);
          return citations.formatResults(results);
        });
      },
    }),
    defineTool('search_api', {
      description:
        'Search the commit-pinned microsoft/aspire public C# API surface for exact types, members, signatures, and XML documentation.',
      parameters: queryParameters,
      skipPermission: true,
      defer: 'never',
      handler: async (input) => {
        signal?.throwIfAborted();
        const { query } = queryParameters.parse(input);
        return await budget.invoke('search_api', async () => {
          signal?.throwIfAborted();
          const vector = await embeddings.embed(sanitizeForAgent(query), signal);
          signal?.throwIfAborted();
          const results = await qdrant.searchApi(vector, config.resultsPerTool, signal);
          signal?.throwIfAborted();
          return citations.formatResults(results);
        });
      },
    }),
  ];
}
