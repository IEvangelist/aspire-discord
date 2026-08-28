import { QdrantClient } from '@qdrant/js-client-rest';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { VectorSearchResult } from '../domain.js';

const payloadSchema = z.object({
  content: z.string(),
  heading: z.string().optional().default(''),
  path: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.url(),
});

export class QdrantStore {
  readonly #client: QdrantClient;

  public constructor(
    private readonly config: AppConfig['qdrant'],
    private readonly logger: Logger,
  ) {
    this.#client = new QdrantClient({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      checkCompatibility: true,
      maxConnections: 32,
      timeout: 20_000,
      url: config.url,
    });
  }

  public async isReady(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const [docs, api] = await Promise.all([
      this.#client.collectionExists(this.config.docsCollection),
      this.#client.collectionExists(this.config.apiCollection),
    ]);
    signal?.throwIfAborted();
    return docs.exists && api.exists;
  }

  public async searchDocs(
    vector: readonly number[],
    limit: number,
    scoreThreshold?: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]> {
    return await this.#search(this.config.docsCollection, vector, limit, scoreThreshold, signal);
  }

  public async searchApi(
    vector: readonly number[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]> {
    return await this.#search(this.config.apiCollection, vector, limit, undefined, signal);
  }

  async #search(
    collection: string,
    vector: readonly number[],
    limit: number,
    scoreThreshold?: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchResult[]> {
    signal?.throwIfAborted();
    const response = await this.#client.query(collection, {
      limit,
      query: [...vector],
      ...(scoreThreshold === undefined ? {} : { score_threshold: scoreThreshold }),
      with_payload: true,
      with_vector: false,
    });
    signal?.throwIfAborted();

    const results: VectorSearchResult[] = [];
    for (const point of response.points) {
      const payload = payloadSchema.safeParse(point.payload);
      if (!payload.success) {
        this.logger.warn(
          {
            collection,
            pointId: String(point.id),
            validationIssues: payload.error.issues.map((issue) => ({
              message: issue.message,
              path: issue.path.join('.'),
            })),
          },
          'Ignoring a Qdrant point with an invalid payload.',
        );
        continue;
      }

      results.push({
        content: payload.data.content,
        ...(payload.data.heading ? { heading: payload.data.heading } : {}),
        path: payload.data.path,
        repo: payload.data.repo,
        score: point.score,
        title: payload.data.title,
        url: payload.data.url,
      });
    }
    return results;
  }
}
