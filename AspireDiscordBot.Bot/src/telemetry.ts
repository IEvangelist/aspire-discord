export type TelemetryMode = 'azure-monitor' | 'disabled' | 'otlp';

export interface TelemetryHandle {
  readonly mode: TelemetryMode;
  shutdown(): Promise<void>;
}

export async function startTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryHandle> {
  const mode = resolveTelemetryMode(environment);
  if (mode === 'azure-monitor') {
    return await startAzureMonitor(environment);
  }
  if (mode === 'disabled') {
    return createTelemetryHandle(mode, async () => undefined);
  }

  const [
    { getNodeAutoInstrumentations },
    { OTLPMetricExporter },
    { OTLPTraceExporter },
    { PeriodicExportingMetricReader },
    { NodeSDK },
  ] = await Promise.all([
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/sdk-node'),
  ]);
  const tracesEndpoint =
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    appendSignalPath(environment.OTEL_EXPORTER_OTLP_ENDPOINT, 'traces');
  const metricsEndpoint =
    environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    appendSignalPath(environment.OTEL_EXPORTER_OTLP_ENDPOINT, 'metrics');

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
    serviceName: environment.OTEL_SERVICE_NAME ?? 'aspire-discord-bot',
    ...(tracesEndpoint ? { traceExporter: new OTLPTraceExporter({ url: tracesEndpoint }) } : {}),
  });
  sdk.start();
  return createTelemetryHandle(mode, async () => {
    await sdk.shutdown();
  });
}

export function resolveTelemetryMode(environment: NodeJS.ProcessEnv): TelemetryMode {
  if (hasValue(environment.APPLICATIONINSIGHTS_CONNECTION_STRING)) {
    return 'azure-monitor';
  }
  if (
    hasValue(environment.OTEL_EXPORTER_OTLP_ENDPOINT) ||
    hasValue(environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ||
    hasValue(environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)
  ) {
    return 'otlp';
  }
  return 'disabled';
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

async function startAzureMonitor(environment: NodeJS.ProcessEnv): Promise<TelemetryHandle> {
  const connectionString = environment.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('APPLICATIONINSIGHTS_CONNECTION_STRING is required for Azure Monitor.');
  }

  const [
    { DefaultAzureCredential },
    { shutdownAzureMonitor, useAzureMonitor },
    { PinoInstrumentation },
  ] = await Promise.all([
    import('@azure/identity'),
    import('@azure/monitor-opentelemetry'),
    import('@opentelemetry/instrumentation-pino'),
  ]);
  const healthPaths = new Set(['/health', '/ready']);
  const httpInstrumentation = {
    enabled: true,
    ignoreIncomingRequestHook(request: { readonly url?: string }): boolean {
      return healthPaths.has(request.url?.split('?', 1)[0] ?? '');
    },
  };
  useAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString,
      credential: new DefaultAzureCredential(),
      ...(environment.APPLICATIONINSIGHTS_STORAGE_DIRECTORY
        ? { storageDirectory: environment.APPLICATIONINSIGHTS_STORAGE_DIRECTORY }
        : {}),
    },
    browserSdkLoaderOptions: { enabled: false },
    enableLiveMetrics: true,
    enableStandardMetrics: true,
    enableTraceBasedSamplingForLogs: false,
    instrumentationOptions: {
      console: { enabled: false },
      http: httpInstrumentation,
    },
    samplingRatio: 1,
    tracesPerSecond: 0,
  });

  const pinoInstrumentation = new PinoInstrumentation();
  pinoInstrumentation.enable();
  return createTelemetryHandle('azure-monitor', async () => {
    pinoInstrumentation.disable();
    await shutdownAzureMonitor();
  });
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function createTelemetryHandle(
  mode: TelemetryMode,
  shutdown: () => Promise<void>,
): TelemetryHandle {
  let shutdownPromise: Promise<void> | undefined;
  return {
    mode,
    shutdown: () => {
      shutdownPromise ??= shutdown();
      return shutdownPromise;
    },
  };
}
