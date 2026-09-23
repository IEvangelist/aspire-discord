import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Azure Monitor export contract', () => {
  it('exports named independent requests with correlated logs, dependencies, and failures', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        '@azure/monitor-opentelemetry/loader',
        '--import',
        'tsx',
        fileURLToPath(new URL('../fixtures/azure-monitor-export.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {
          ...process.env,
          APPLICATIONINSIGHTS_STATSBEAT_DISABLED: 'true',
          APPLICATION_INSIGHTS_NO_STATSBEAT: 'true',
          APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'true',
          OTEL_LOGS_EXPORTER: 'none',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_NODE_RESOURCE_DETECTORS: 'none',
        },
        timeout: 25_000,
      },
    );
    expect(stdout).toContain('AZURE_MONITOR_EXPORT_OK');
  });
});
