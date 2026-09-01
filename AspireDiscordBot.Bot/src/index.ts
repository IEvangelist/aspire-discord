import { startTelemetry, type TelemetryHandle } from './telemetry.js';

let telemetry: TelemetryHandle | undefined;

try {
  telemetry = await startTelemetry();
  const { main } = await import('./main.js');
  await main(telemetry);
} catch (error) {
  console.error(error);
  try {
    await telemetry?.shutdown();
  } catch (shutdownError) {
    console.error('Telemetry shutdown failed.', shutdownError);
  }
  process.exitCode = 1;
}
