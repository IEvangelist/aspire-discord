import { describe, expect, it } from 'vitest';
import { appendSignalPath } from '../../src/telemetry.js';

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
