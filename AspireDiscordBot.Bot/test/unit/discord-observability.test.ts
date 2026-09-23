import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { observeDiscordMention } from '../../src/discord/observability.js';
import { useTestTelemetry } from '../helpers/telemetry.js';

const exporter = useTestTelemetry();
const tracer = trace.getTracer('discord-observability-tests');
const message = {
  author: { id: 'user' },
  channelId: 'channel',
  guildId: 'guild',
  id: 'message',
};

describe('Discord request tracing', () => {
  it('starts independent named consumer traces under a stale gateway context', async () => {
    const gateway = tracer.startSpan('gateway connection');
    gateway.end();
    await context.with(trace.setSpan(context.active(), gateway), async () => {
      await Promise.all(
        ['one', 'two'].map(async (id) => {
          await observeDiscordMention({ ...message, id }, async (observation) => {
            const request = trace.getActiveSpan();
            await Promise.resolve();
            expect(trace.getActiveSpan()).toBe(request);
            const child = tracer.startSpan(`answer ${id}`);
            child.end();
            observation.complete('answered');
          });
        }),
      );
    });

    const spans = exporter.getFinishedSpans();
    const requests = spans.filter((span) => span.kind === SpanKind.CONSUMER);
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((span) => span.spanContext().traceId)).size).toBe(2);
    for (const request of requests) {
      expect(request.parentSpanContext).toBeUndefined();
      expect(request.spanContext().traceId).not.toBe(gateway.spanContext().traceId);
      expect(request.name).toBe('process discord mention');
      expect(request.attributes).toMatchObject({
        'ai.operation.name': 'process discord mention',
        'messaging.system': 'discord',
        'aspire.discord.request.outcome': 'answered',
      });
      const child = spans.find(
        (span) => span.name === `answer ${String(request.attributes['messaging.message.id'])}`,
      );
      expect(child?.spanContext().traceId).toBe(request.spanContext().traceId);
      expect(child?.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    }
  });

  it('records and rethrows failures on the request trace', async () => {
    const failure = new Error('Discord send failed');
    await expect(
      observeDiscordMention(message, async () => {
        await Promise.resolve();
        throw failure;
      }),
    ).rejects.toBe(failure);
    const [request] = exporter.getFinishedSpans();
    expect(request?.status.code).toBe(SpanStatusCode.ERROR);
    expect(request?.attributes['aspire.discord.request.outcome']).toBe('failed');
    expect(request?.events).toEqual([
      expect.objectContaining({
        name: 'exception',
        attributes: expect.objectContaining({ 'exception.message': failure.message }),
      }),
    ]);
  });
});
