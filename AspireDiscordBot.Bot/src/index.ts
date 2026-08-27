import { startTelemetry } from './telemetry.js';

const telemetry = await startTelemetry();
const { main } = await import('./main.js');

try {
  await main(telemetry);
} catch (error) {
  console.error(error);
  await telemetry.shutdown();
  process.exitCode = 1;
}
