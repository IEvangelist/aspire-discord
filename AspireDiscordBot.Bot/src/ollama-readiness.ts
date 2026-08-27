import type { AppConfig } from './config.js';
import type { Logger } from 'pino';

export async function ensureOllamaModels(
  config: AppConfig['ai'],
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  const models = new Map<string, string>();
  if (config.provider === 'ollama') {
    models.set(config.chatModel, config.endpoint ?? config.embeddingEndpoint);
  }
  if (config.embeddingProvider === 'ollama') {
    models.set(config.embeddingModel, config.embeddingEndpoint);
  }

  for (const [model, endpoint] of models) {
    const timeout = AbortSignal.timeout(30 * 60_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(
      `${endpoint.replace(/\/v1\/?$/u, '').replace(/\/+$/u, '')}/api/pull`,
      {
        body: JSON.stringify({ model, stream: false }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: requestSignal,
      },
    );
    if (!response.ok) {
      throw new Error(`Ollama model pull failed for '${model}' (${String(response.status)}).`);
    }
    logger.info({ model }, 'Ollama model is ready.');
  }
}
