import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordProgressController, progressMessage } from '../../src/discord/progress.js';
import { testLogger } from '../helpers/logger.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Discord progress', () => {
  it('shows phases, refreshes activity, and stops cleanly', async () => {
    vi.useFakeTimers();
    const update = vi.fn<(content: string) => Promise<void>>(async () => undefined);
    const sendTyping = vi.fn<() => Promise<void>>(async () => undefined);
    const progress = new DiscordProgressController({
      logger: testLogger,
      minimumUpdateMilliseconds: 0,
      refreshMilliseconds: 8_000,
      seed: 'request-1',
      sendTyping,
      update,
    });

    await progress.start();
    await progress.report({ phase: 'searching-docs' });
    await vi.advanceTimersByTimeAsync(8_000);

    expect(update).toHaveBeenCalledTimes(3);
    expect(update.mock.calls[1]?.[0]).toContain('Aspire');
    expect(sendTyping).toHaveBeenCalledTimes(3);

    await progress.stop();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('coalesces rapid phases to avoid delaying the final edit', async () => {
    vi.useFakeTimers();
    const update = vi.fn<(content: string) => Promise<void>>(async () => undefined);
    const progress = new DiscordProgressController({
      logger: testLogger,
      minimumUpdateMilliseconds: 2_000,
      refreshMilliseconds: 8_000,
      seed: 'request-2',
      update,
    });

    await progress.start();
    await progress.report({ phase: 'checking-links' });
    await progress.report({ phase: 'searching-docs' });
    expect(update).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[0]).toContain('Aspire');

    await progress.report({ phase: 'researching' });
    await progress.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('uses restrained deterministic variants', () => {
    expect(progressMessage('writing', 'same-seed')).toBe(progressMessage('writing', 'same-seed'));
    expect(progressMessage('writing', 'same-seed', 1)).not.toBe(
      progressMessage('writing', 'same-seed', 0),
    );
  });
});
