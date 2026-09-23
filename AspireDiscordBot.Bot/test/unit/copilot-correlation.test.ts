import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { SessionConfig, Tool } from '@github/copilot-sdk';
import type * as CopilotSdk from '@github/copilot-sdk';
import type * as FileSystem from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { CopilotRuntime } from '../../src/agent/copilot-runtime.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';
import { useTestTelemetry } from '../helpers/telemetry.js';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystem>()),
  mkdir: vi.fn(async () => undefined),
}));
vi.mock('@github/copilot-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof CopilotSdk>()),
  CopilotClient: class {
    start = vi.fn(async () => undefined);
    createSession = mocks.createSession;
    deleteSession = vi.fn(async () => undefined);
  },
}));

const exporter = useTestTelemetry();
const tracer = trace.getTracer('copilot-correlation-tests');

describe('Copilot callback correlation', () => {
  it('binds tools and progress callbacks to the calling request across the SDK dispatcher', async () => {
    const listeners = new Map<string, (event: { data: { deltaContent: string } }) => void>();
    const progressTraces: (string | undefined)[] = [];
    mocks.createSession.mockImplementation(async (config: SessionConfig) => ({
      sessionId: 'test-session',
      disconnect: vi.fn(async () => undefined),
      on: (name: string, callback: (event: { data: { deltaContent: string } }) => void) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
      sendAndWait: async () =>
        await context.with(ROOT_CONTEXT, async () => {
          const tool = config.tools?.find((candidate) => candidate.name === 'lookup');
          expect(tool?.handler).toBeDefined();
          await tool?.handler?.(
            {},
            {
              arguments: {},
              sessionId: 'test-session',
              toolCallId: 'test-call',
              toolName: 'lookup',
            },
          );
          listeners.get('tool.execution_start')?.({ data: { deltaContent: '' } });
          listeners.get('assistant.message_delta')?.({ data: { deltaContent: 'answer' } });
          return { data: { content: 'answer' } };
        }),
    }));
    const runtime = new CopilotRuntime(createTestConfig(), testLogger);
    const tool: Tool = {
      name: 'lookup',
      handler: async () => {
        await Promise.resolve();
        const span = tracer.startSpan('tool lookup');
        span.end();
        return 'found';
      },
    };
    await tracer.startActiveSpan('request agent', async (span) => {
      await expect(
        runtime.complete('question', [tool, { name: 'external' }], undefined, async () => {
          progressTraces.push(trace.getActiveSpan()?.spanContext().traceId);
        }),
      ).resolves.toBe('answer');
      span.end();
    });
    const spans = exporter.getFinishedSpans();
    const request = spans.find((span) => span.name === 'request agent');
    const lookup = spans.find((span) => span.name === 'tool lookup');
    expect(lookup?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(lookup?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(progressTraces).toEqual([
      request?.spanContext().traceId,
      request?.spanContext().traceId,
    ]);
    expect(listeners.size).toBe(0);
    expect(tool.handler).toBeDefined();
  });
});
