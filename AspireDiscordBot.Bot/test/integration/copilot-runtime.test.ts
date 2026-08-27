import { describe, expect, it } from 'vitest';
import { CopilotRuntime } from '../../src/agent/copilot-runtime.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

describe('Copilot runtime integration', () => {
  it('starts and stops the bundled runtime in empty mode', async () => {
    const runtime = new CopilotRuntime(createTestConfig(), testLogger);
    await runtime.start();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
