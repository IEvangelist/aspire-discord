import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { mock } from 'node:test';
import { gunzipSync } from 'node:zlib';
import type * as AzureDetectors from '@opentelemetry/resource-detector-azure';

// The distro and Node auto-instrumentations depend on different detector versions.
const monitorRequire = createRequire(import.meta.resolve('@azure/monitor-opentelemetry'));
const { azureVmDetector } = monitorRequire(
  '@opentelemetry/resource-detector-azure',
) as typeof AzureDetectors;
mock.method(azureVmDetector, 'detect', () => ({ attributes: {} }));
const unexpectedConnections: string[] = [];
mock.method(Socket.prototype, 'connect', () => {
  const error = new Error('The telemetry export fixture must not open network connections.');
  unexpectedConnections.push(error.stack ?? error.message);
  throw error;
});

interface Envelope {
  readonly tags: Record<string, string>;
  readonly data: {
    readonly baseType: string;
    readonly baseData: {
      readonly id?: string;
      readonly name?: string;
      readonly message?: string;
      readonly success?: boolean;
    };
  };
}

const envelopes: Envelope[] = [];
const { useAzureMonitor, shutdownAzureMonitor } = await import('@azure/monitor-opentelemetry');
const { context, trace } = await import('@opentelemetry/api');
const { PinoInstrumentation } = await import('@opentelemetry/instrumentation-pino');
useAzureMonitor({
  azureMonitorExporterOptions: {
    connectionString:
      'InstrumentationKey=00000000-0000-0000-0000-000000000001;IngestionEndpoint=https://collector.invalid/',
    disableOfflineStorage: true,
    httpClient: {
      async sendRequest(request) {
        assert.equal(new URL(request.url).hostname, 'collector.invalid');
        const body = typeof request.body === 'function' ? request.body() : request.body;
        const chunks: Uint8Array[] = [];
        if (typeof body === 'string') {
          chunks.push(Buffer.from(body));
        } else if (body instanceof Uint8Array) {
          chunks.push(body);
        } else {
          assert(body && typeof body === 'object' && Symbol.asyncIterator in body);
          for await (const chunk of body as AsyncIterable<Uint8Array>) {
            chunks.push(chunk);
          }
        }
        const bytes = Buffer.concat(chunks);
        const payload =
          request.headers.get('content-encoding') === 'gzip' ? gunzipSync(bytes) : bytes;
        const batch = payload
          .toString('utf8')
          .trim()
          .split('\n')
          .flatMap((line) => JSON.parse(line) as Envelope | Envelope[]);
        envelopes.push(...batch);
        return {
          request,
          status: 200,
          headers: request.headers,
          bodyAsText: JSON.stringify({
            itemsReceived: batch.length,
            itemsAccepted: batch.length,
            errors: [],
          }),
        };
      },
    },
  },
  enableLiveMetrics: false,
  enableStandardMetrics: false,
  enablePerformanceCounters: false,
  enableTraceBasedSamplingForLogs: false,
  instrumentationOptions: { http: { enabled: false }, azureSdk: { enabled: false } },
  samplingRatio: 1,
  tracesPerSecond: 0,
});
const pinoInstrumentation = new PinoInstrumentation();
pinoInstrumentation.enable();
try {
  const { createLogger } = await import('../../src/logger.js');
  const { observeDiscordMention } = await import('../../src/discord/observability.js');
  const logger = createLogger({ logLevel: 'info', nodeEnvironment: 'production' });
  const tracer = trace.getTracer('export-regression');
  const connection = tracer.startSpan('old gateway connection');
  connection.end();
  await context.with(trace.setSpan(context.active(), connection), async () => {
    for (const id of ['first', 'second']) {
      await observeDiscordMention(
        {
          author: { id: 'test-user' },
          channelId: 'test-channel',
          guildId: 'test-guild',
          id,
        },
        async (observation) => {
          logger.info({ discordMessageId: id }, `request ${id}`);
          const child = tracer.startSpan(`child ${id}`);
          child.end();
          if (id === 'second') {
            observation.fail(new Error('synthetic failure'));
          } else {
            observation.complete('answered');
          }
        },
      );
    }
  });
} finally {
  await shutdownAzureMonitor();
  pinoInstrumentation.disable();
}

const requests = envelopes.filter((envelope) => envelope.data.baseType === 'RequestData');
assert.deepEqual(unexpectedConnections, []);
assert.equal(requests.length, 2);
assert.equal(new Set(requests.map((request) => request.tags['ai.operation.id'])).size, 2);
assert.deepEqual(
  requests.map((request) => request.data.baseData.success),
  [true, false],
);
for (const [index, request] of requests.entries()) {
  const id = index === 0 ? 'first' : 'second';
  assert.equal(request.data.baseData.name, 'process discord mention');
  assert.equal(request.tags['ai.operation.name'], 'process discord mention');
  assert.equal(request.tags['ai.operation.parentId'], undefined);
  const log = envelopes.find((envelope) => envelope.data.baseData.message === `request ${id}`);
  const child = envelopes.find((envelope) => envelope.data.baseData.name === `child ${id}`);
  assert.equal(log?.tags['ai.operation.id'], request.tags['ai.operation.id']);
  assert.equal(child?.tags['ai.operation.id'], request.tags['ai.operation.id']);
  assert.equal(child?.tags['ai.operation.parentId'], request.data.baseData.id);
}
const exception = envelopes.find((envelope) => envelope.data.baseType === 'ExceptionData');
assert.equal(exception?.tags['ai.operation.id'], requests[1]?.tags['ai.operation.id']);
console.log('AZURE_MONITOR_EXPORT_OK');
