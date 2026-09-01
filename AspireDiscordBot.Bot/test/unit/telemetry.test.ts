import { describe, expect, it } from 'vitest';
import { appendSignalPath, resolveTelemetryMode } from '../../src/telemetry.js';

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
