import { describe, expect, it, vi } from 'vitest';
import { waitForIndexReadiness } from '../../src/main.js';
import { testLogger } from '../helpers/logger.js';

describe('service startup readiness', () => {
  it('waits until both Qdrant indexes are available', async () => {
    const isReady = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await waitForIndexReadiness({ isReady }, testLogger, new AbortController().signal, 0);

    expect(isReady).toHaveBeenCalledTimes(2);
  });

  it('stops waiting when startup is cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopping'));

    await expect(
      waitForIndexReadiness({ isReady: async () => false }, testLogger, controller.signal, 0),
    ).rejects.toThrow('stopping');
  });
});
