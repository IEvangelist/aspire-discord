import {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import type { AiProvider } from './config.js';

export const genAiTracer = trace.getTracer('AspireDiscordBot.GenAI');

const meter = metrics.getMeter('AspireDiscordBot.GenAI');
const tokenUsage = meter.createHistogram('gen_ai.client.token.usage', {
  description: 'Number of input and output tokens used.',
  unit: '{token}',
});
const clientDuration = meter.createHistogram('gen_ai.client.operation.duration', {
  description: 'GenAI client operation duration.',
  unit: 's',
});
const agentDuration = meter.createHistogram('gen_ai.invoke_agent.duration', {
  description: 'GenAI agent invocation duration.',
  unit: 's',
});

export interface GenAiOperation {
  readonly model: string;
  readonly operation: 'chat' | 'embeddings';
  readonly provider: AiProvider;
  readonly serverAddress?: string;
}

export interface AgentOperation {
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly provider: AiProvider;
  readonly reasoningLevel: string;
}

export function providerName(provider: AiProvider): string {
  switch (provider) {
    case 'azureaifoundry':
    case 'azureopenai':
      return 'azure.ai.openai';
    case 'ollama':
      return 'ollama';
    case 'copilot':
    case 'openai':
      return 'openai';
  }
}

export function operationAttributes(operation: GenAiOperation): Attributes {
  const provider = providerName(operation.provider);
  return {
    'gen_ai.operation.name': operation.operation,
    'gen_ai.provider.name': provider,
    'gen_ai.request.model': operation.model,
    'gen_ai.system': provider,
    ...(operation.serverAddress ? { 'server.address': operation.serverAddress } : {}),
  };
}

export async function withAgentSpan<T>(
  operation: AgentOperation,
  execute: (span: Span) => Promise<T>,
): Promise<T> {
  const attributes: Attributes = {
    ...operationAttributes({
      model: operation.model,
      operation: 'chat',
      provider: operation.provider,
    }),
    'gen_ai.agent.name': 'aspire-docs-agent',
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.request.max_tokens': operation.maxOutputTokens,
    'gen_ai.request.reasoning.level': operation.reasoningLevel,
  };
  const started = performance.now();
  let failureType: string | undefined;

  return await genAiTracer.startActiveSpan(
    'invoke_agent aspire-docs-agent',
    { attributes, kind: SpanKind.INTERNAL },
    async (span) => {
      try {
        const result = await execute(span);
        span.setAttribute('gen_ai.response.model', operation.model);
        return result;
      } catch (error) {
        failureType = recordSpanError(span, error);
        throw error;
      } finally {
        agentDuration.record((performance.now() - started) / 1_000, {
          'gen_ai.agent.name': 'aspire-docs-agent',
          'gen_ai.provider.name': providerName(operation.provider),
          ...(failureType ? { 'error.type': failureType } : {}),
        });
        span.end();
      }
    },
  );
}

export function recordClientDuration(
  operation: GenAiOperation,
  durationSeconds: number,
  failureType?: string,
): void {
  clientDuration.record(durationSeconds, {
    ...operationAttributes(operation),
    ...(failureType ? { 'error.type': failureType } : {}),
  });
}

export function recordTokenUsage(
  span: Span,
  operation: GenAiOperation,
  inputTokens?: number,
  outputTokens?: number,
): void {
  const attributes = operationAttributes(operation);
  if (inputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.input_tokens', inputTokens);
    tokenUsage.record(inputTokens, {
      ...attributes,
      'gen_ai.token.type': 'input',
    });
  }
  if (outputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.output_tokens', outputTokens);
    tokenUsage.record(outputTokens, {
      ...attributes,
      'gen_ai.token.type': 'output',
    });
  }
}

export function recordSpanError(span: Span, error: unknown): string {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const failureType = normalized.name || 'Error';
  span.recordException(normalized);
  span.setAttribute('error.type', failureType);
  span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
  return failureType;
}
