import { describe, expect, it, vi } from 'vitest';
import { appendSignalPath, resolveTelemetryMode, startTelemetry } from '../../src/telemetry.js';

const azureMonitor = vi.hoisted(() => ({
  useAzureMonitor: vi.fn(),
  shutdownAzureMonitor: vi.fn(async () => undefined),
}));
vi.mock('@azure/monitor-opentelemetry', () => azureMonitor);

describe('OTLP signal endpoints', () => {
  it('builds trace and metric endpoints from an OTLP base URL', () => {
    expect(appendSignalPath('http://localhost:4318/', 'traces')).toBe(
      'http://localhost:4318/v1/traces',
    );
    expect(appendSignalPath('http://localhost:4318', 'metrics')).toBe(
      'http://localhost:4318/v1/metrics',
    );
  });

  it('preserves an explicit signal endpoint', () => {
    expect(appendSignalPath('http://localhost:4318/v1/traces', 'traces')).toBe(
      'http://localhost:4318/v1/traces',
    );
  });
});

describe('telemetry mode', () => {
  it('keeps all request traces rather than letting the rate cap override 100% sampling', async () => {
    const telemetry = await startTelemetry({
      APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=test',
    });
    expect(azureMonitor.useAzureMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        samplingRatio: 1,
        tracesPerSecond: 0,
        enableTraceBasedSamplingForLogs: false,
      }),
    );
    await telemetry.shutdown();
  });

  it('prefers Azure Monitor when its connection string is configured', () => {
    expect(
      resolveTelemetryMode({
        APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=test',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    ).toBe('azure-monitor');
  });

  it('uses OTLP when a signal endpoint is configured', () => {
    expect(
      resolveTelemetryMode({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/v1/traces',
      }),
    ).toBe('otlp');
  });

  it('stays disabled without an exporter destination', () => {
    expect(resolveTelemetryMode({})).toBe('disabled');
  });
});
