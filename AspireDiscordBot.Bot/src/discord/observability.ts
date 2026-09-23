import {
  metrics,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import type { Message } from 'discord.js';

const tracer = trace.getTracer('AspireDiscordBot.Discord');
const mentionOperationName = 'process discord mention';
const meter = metrics.getMeter('AspireDiscordBot.Discord');
const requestCount = meter.createCounter('aspire.discord.requests', {
  description: 'Discord mentions received by outcome.',
  unit: '{request}',
});
const requestDuration = meter.createHistogram('aspire.discord.request.duration', {
  description: 'End-to-end Discord mention processing duration.',
  unit: 's',
});
const responseMessages = meter.createHistogram('aspire.discord.response.messages', {
  description: 'Discord messages emitted for one answer.',
  unit: '{message}',
});
const gatewayEvents = meter.createCounter('aspire.discord.gateway.events', {
  description: 'Discord gateway lifecycle events.',
  unit: '{event}',
});

export type DiscordRequestOutcome =
  | 'answered'
  | 'busy'
  | 'configuration_unavailable'
  | 'duplicate'
  | 'failed'
  | 'image_rejected'
  | 'invalid_question'
  | 'issue_handled'
  | 'not_authorized'
  | 'not_grounded'
  | 'rate_limited'
  | 'text_rejected'
  | 'unclassified';

export type DiscordGatewayEvent =
  | 'client_error'
  | 'command_cleanup_failed'
  | 'disconnected'
  | 'invalidated'
  | 'login_failed'
  | 'ready'
  | 'reconnecting'
  | 'rest_invalid_request'
  | 'rest_rate_limited'
  | 'resumed'
  | 'shard_error'
  | 'shard_ready'
  | 'stopped'
  | 'warning';

export interface DiscordRequestObservation {
  complete(outcome: DiscordRequestOutcome, attributes?: Attributes): void;
  fail(error: unknown, attributes?: Attributes): void;
}

type DiscordMessageContext = Pick<Message, 'id' | 'channelId' | 'guildId'> & {
  readonly author: Pick<Message['author'], 'id'>;
};

export async function observeDiscordMention<T>(
  message: DiscordMessageContext,
  execute: (observation: DiscordRequestObservation) => Promise<T>,
): Promise<T> {
  return await tracer.startActiveSpan(
    mentionOperationName,
    {
      attributes: discordTraceAttributes(message),
      kind: SpanKind.CONSUMER,
    },
    ROOT_CONTEXT,
    async (span) => {
      const observation = new RequestObservation(span);
      try {
        const result = await execute(observation);
        if (!observation.completed) {
          observation.complete('unclassified');
        }
        return result;
      } catch (error) {
        observation.fail(error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function discordLogContext(message: DiscordMessageContext): Record<string, string> {
  return {
    discordMessageId: message.id,
    discordUserId: message.author.id,
    ...(message.channelId ? { discordChannelId: message.channelId } : {}),
    ...(message.guildId ? { discordGuildId: message.guildId } : {}),
  };
}

export function recordDiscordGatewayEvent(event: DiscordGatewayEvent, shardId?: number): void {
  gatewayEvents.add(1, {
    'aspire.discord.gateway.event': event,
    ...(shardId === undefined ? {} : { 'discord.shard.id': shardId }),
  });
}

class RequestObservation implements DiscordRequestObservation {
  readonly #started = performance.now();
  #completed = false;

  public constructor(private readonly span: Span) {}

  public get completed(): boolean {
    return this.#completed;
  }

  public complete(outcome: DiscordRequestOutcome, attributes: Attributes = {}): void {
    if (this.#completed) {
      return;
    }
    this.span.setAttributes(attributes);
    this.span.setAttribute('aspire.discord.request.outcome', outcome);
    this.span.setStatus({ code: SpanStatusCode.OK });
    this.#recordMetrics(outcome, attributes);
    this.#completed = true;
  }

  public fail(error: unknown, attributes: Attributes = {}): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.span.recordException(normalized);
    this.span.setAttribute('error.type', normalized.name || 'Error');
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
    if (!this.#completed) {
      this.span.setAttributes(attributes);
      this.span.setAttribute('aspire.discord.request.outcome', 'failed');
      this.#recordMetrics('failed', attributes);
      this.#completed = true;
    }
  }

  #recordMetrics(outcome: DiscordRequestOutcome, attributes: Attributes): void {
    const metricAttributes: Attributes = {
      'aspire.discord.request.outcome': outcome,
      ...(attributes['aspire.discord.question.source']
        ? { 'aspire.discord.question.source': attributes['aspire.discord.question.source'] }
        : {}),
      ...(attributes['aspire.discord.answer.grounded'] === undefined
        ? {}
        : { 'aspire.discord.answer.grounded': attributes['aspire.discord.answer.grounded'] }),
    };
    requestCount.add(1, metricAttributes);
    requestDuration.record((performance.now() - this.#started) / 1_000, metricAttributes);
    const messageCount = attributes['aspire.discord.response.message_count'];
    if (typeof messageCount === 'number') {
      responseMessages.record(messageCount, metricAttributes);
    }
  }
}

function discordTraceAttributes(message: DiscordMessageContext): Attributes {
  return {
    // Azure Monitor does not derive operation names from CONSUMER span names.
    'ai.operation.name': mentionOperationName,
    'discord.channel.id': message.channelId,
    'discord.user.id': message.author.id,
    'messaging.message.id': message.id,
    'messaging.operation.name': 'process',
    'messaging.system': 'discord',
    ...(message.guildId ? { 'discord.guild.id': message.guildId } : {}),
  };
}
