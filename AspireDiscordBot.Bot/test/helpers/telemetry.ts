import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export function useTestTelemetry(): tracing.InMemorySpanExporter {
  const exporter = new tracing.InMemorySpanExporter();
  const sdk = new NodeSDK({
    autoDetectResources: false,
    logRecordProcessors: [],
    metricReaders: [],
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  beforeAll(() => {
    sdk.start();
  });
  afterEach(() => {
    exporter.reset();
  });
  afterAll(async () => {
    await sdk.shutdown();
    context.disable();
    propagation.disable();
    trace.disable();
  });
  return exporter;
}
