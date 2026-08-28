import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { VectorSearchResult } from '../domain.js';

const searchDocumentSchema = z.object({
  content: z.string(),
  heading: z.string().optional().default(''),
  path: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.url(),
});

type SearchIndexDocument = z.input<typeof searchDocumentSchema> & {
  readonly contentVector?: readonly number[];
  readonly id: string;
  readonly publicationGroup?: string | null;
};

const selectedFields = ['content', 'heading', 'path', 'repo', 'title', 'url'] as const;

export class AzureSearchStore {
  readonly #api: SearchClient<SearchIndexDocument>;
  readonly #docs: SearchClient<SearchIndexDocument>;

  public constructor(
    config: AppConfig['vectorStore'],
    private readonly logger: Logger,
  ) {
    if (!config.endpoint) {
      throw new Error('Azure AI Search requires VECTOR_STORE_ENDPOINT.');
    }
    const credential = new DefaultAzureCredential();
    this.#api = new SearchClient(config.endpoint, config.apiIndex, credential);
    this.#docs = new SearchClient(config.endpoint, config.docsIndex, credential);
  }

  public async isReady(signal?: AbortSignal): Promise<boolean> {
    const [docs, api] = await Promise.all([
      this.#publicationGroup(this.#docs, signal),
      this.#publicationGroup(this.#api, signal),
    ]);
    return Boolean(docs && docs === api);
  }

  public async searchDocs(
    vector: readonly number[],
    limit: number,
    scoreThreshold?: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]> {
    return await this.#search(this.#docs, vector, limit, scoreThreshold, signal);
  }

  public async searchApi(
    vector: readonly number[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]> {
    return await this.#search(this.#api, vector, limit, undefined, signal);
  }

  async #search(
    client: SearchClient<SearchIndexDocument>,
    vector: readonly number[],
    limit: number,
    scoreThreshold?: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]> {
    const request = boundedRequest(signal);
    const response = await client.search(undefined, {
      ...request,
      select: selectedFields,
      top: limit,
      vectorSearchOptions: {
        queries: [
          {
            fields: ['contentVector'],
            kNearestNeighborsCount: limit,
            kind: 'vector',
            vector: [...vector],
          },
        ],
      },
    });
    const results: VectorSearchResult[] = [];
    for await (const result of response.results) {
      const document = searchDocumentSchema.safeParse(result.document);
      if (!document.success) {
        this.logger.warn(
          {
            indexName: client.indexName,
            validationIssues: document.error.issues.map((issue) => ({
              message: issue.message,
              path: issue.path.join('.'),
            })),
          },
          'Ignoring an Azure AI Search document with an invalid payload.',
        );
        continue;
      }

      const score = azureSearchScoreToCosineSimilarity(result.score);
      if (scoreThreshold !== undefined && score < scoreThreshold) {
        continue;
      }
      results.push({
        content: document.data.content,
        ...(document.data.heading ? { heading: document.data.heading } : {}),
        path: document.data.path,
        repo: document.data.repo,
        score,
        title: document.data.title,
        url: document.data.url,
      });
    }
    return results;
  }

  async #publicationGroup(
    client: SearchClient<SearchIndexDocument>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const response = await client.search(undefined, {
      ...boundedRequest(signal),
      select: ['publicationGroup'],
      top: 1,
    });
    for await (const result of response.results) {
      return result.document.publicationGroup ?? undefined;
    }
    return undefined;
  }
}

export function azureSearchScoreToCosineSimilarity(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return -1;
  }
  return Math.max(-1, Math.min(1, 2 - 1 / score));
}

function boundedRequest(signal?: AbortSignal): {
  readonly abortSignal: AbortSignal;
  readonly requestOptions: { readonly timeout: number };
} {
  const timeout = AbortSignal.timeout(20_000);
  return {
    abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    requestOptions: { timeout: 20_000 },
  };
}
