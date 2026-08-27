import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export async function startTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryHandle> {
  const tracesEndpoint =
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    appendTracePath(environment.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!tracesEndpoint) {
    return { shutdown: async () => undefined };
  }

  const sdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
    serviceName: 'aspire-discord-bot',
    traceExporter: new OTLPTraceExporter({ url: tracesEndpoint }),
  });
  sdk.start();
  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}

function appendTracePath(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  const trimmed = endpoint.replace(/\/+$/u, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}
