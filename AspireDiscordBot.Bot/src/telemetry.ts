import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export async function startTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryHandle> {
  const tracesEndpoint =
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    appendSignalPath(environment.OTEL_EXPORTER_OTLP_ENDPOINT, 'traces');
  const metricsEndpoint =
    environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    appendSignalPath(environment.OTEL_EXPORTER_OTLP_ENDPOINT, 'metrics');
  if (!tracesEndpoint && !metricsEndpoint) {
    return { shutdown: async () => undefined };
  }

  const sdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
    ...(metricsEndpoint
      ? {
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
            exportIntervalMillis: 5_000,
            exportTimeoutMillis: 4_000,
          }),
        }
      : {}),
    serviceName: 'aspire-discord-bot',
    ...(tracesEndpoint ? { traceExporter: new OTLPTraceExporter({ url: tracesEndpoint }) } : {}),
  });
  sdk.start();
  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}

export function appendSignalPath(
  endpoint: string | undefined,
  signal: 'metrics' | 'traces',
): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  const trimmed = endpoint.replace(/\/+$/u, '');
  const suffix = `/v1/${signal}`;
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}
