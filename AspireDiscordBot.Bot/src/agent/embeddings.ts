import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { SpanKind } from '@opentelemetry/api';
import OpenAI, { AzureOpenAI } from 'openai';
import type { AppConfig } from '../config.js';
import {
  genAiTracer,
  operationAttributes,
  recordClientDuration,
  recordSpanError,
  recordTokenUsage,
} from '../genai-telemetry.js';

const foundryTokenScope = 'https://ai.azure.com/.default';
const foundryBearerTokenProvider = getBearerTokenProvider(
  new DefaultAzureCredential(),
  foundryTokenScope,
);

export async function getFoundryBearerToken(): Promise<string> {
  return await foundryBearerTokenProvider();
}

export interface EmbeddingModel {
  embed(input: string, signal?: AbortSignal): Promise<readonly number[]>;
}

export class OpenAiEmbeddingModel implements EmbeddingModel {
  readonly #client: OpenAI;
  readonly #dimensions: number;
  readonly #model: string;

  public constructor(private readonly config: AppConfig['ai']) {
    this.#dimensions = config.embeddingDimensions;
    this.#model = config.embeddingModel;
    this.#client = createEmbeddingClient(config);
  }

  public async embed(input: string, signal?: AbortSignal): Promise<readonly number[]> {
    const operation = {
      model: this.#model,
      operation: 'embeddings' as const,
      provider: this.config.embeddingProvider,
      serverAddress: new URL(this.config.embeddingEndpoint).hostname,
    };
    const started = performance.now();
    let failureType: string | undefined;

    return await genAiTracer.startActiveSpan(
      `embeddings ${this.#model}`,
      {
        attributes: {
          ...operationAttributes(operation),
          'gen_ai.embeddings.dimension.count': this.#dimensions,
          'gen_ai.request.input_count': 1,
        },
        kind: SpanKind.CLIENT,
      },
      async (span) => {
        try {
          const response = await this.#client.embeddings.create(
            {
              dimensions: this.#dimensions,
              encoding_format: 'float',
              input,
              model: this.#model,
            },
            signal ? { signal } : undefined,
          );
          const embedding = response.data[0]?.embedding;
          if (embedding?.length !== this.#dimensions) {
            throw new Error(
              `Embedding provider returned ${embedding?.length ?? 0} dimensions; expected ${this.#dimensions}.`,
            );
          }
          span.setAttribute('gen_ai.response.model', response.model);
          recordTokenUsage(span, operation, response.usage.prompt_tokens);
          return embedding;
        } catch (error) {
          failureType = recordSpanError(span, error);
          throw error;
        } finally {
          recordClientDuration(operation, (performance.now() - started) / 1_000, failureType);
          span.end();
        }
      },
    );
  }
}

function createEmbeddingClient(config: AppConfig['ai']): OpenAI {
  const common = {
    maxRetries: 2,
    timeout: 30_000,
  };

  switch (config.embeddingProvider) {
    case 'azureopenai':
      return new AzureOpenAI({
        ...common,
        apiKey: config.embeddingApiKey,
        apiVersion: config.embeddingApiVersion,
        deployment: config.embeddingModel,
        endpoint: config.embeddingEndpoint,
      });
    case 'ollama':
      return new OpenAI({
        ...common,
        apiKey: config.embeddingApiKey ?? 'ollama',
        baseURL: ensureV1Endpoint(config.embeddingEndpoint),
      });
    case 'openai':
      return new OpenAI({
        ...common,
        apiKey: config.embeddingApiKey,
        baseURL: ensureV1Endpoint(config.embeddingEndpoint),
      });
    case 'azureaifoundry':
      return new OpenAI({
        ...common,
        apiKey: getFoundryBearerToken,
        baseURL: ensureFoundryV1Endpoint(config.embeddingEndpoint),
      });
    case 'copilot':
      throw new Error(
        'GitHub Copilot has no supported embeddings endpoint. Configure AI_EMBEDDING_PROVIDER.',
      );
  }
}

export function ensureV1Endpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/u, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function ensureFoundryV1Endpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/u, '');
  return trimmed.toLocaleLowerCase('en-US').endsWith('/openai/v1')
    ? trimmed
    : `${trimmed}/openai/v1`;
}
