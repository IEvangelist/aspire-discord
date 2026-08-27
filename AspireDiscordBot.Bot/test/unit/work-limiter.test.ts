import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WorkLimiter, WorkQueueFullError } from '../../src/work-limiter.js';

describe('WorkLimiter', () => {
  it('bounds concurrency and drains queued work', async () => {
    const limiter = new WorkLimiter(1, 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = limiter.run(async () => {
      await gate;
      return 1;
    });
    const second = limiter.run(async () => 2);

    expect(limiter.active).toBe(1);
    expect(limiter.queued).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  });

  it('rejects work beyond the queue bound', async () => {
    const limiter = new WorkLimiter(1, 0);
    const first = limiter.run(async () => await new Promise<never>(() => undefined));

    await expect(limiter.run(async () => 2)).rejects.toBeInstanceOf(WorkQueueFullError);
    void first;
  });

  it('removes queued work when its signal is aborted', async () => {
    const limiter = new WorkLimiter(1, 2);
    let release!: () => void;
    const active = limiter.run(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const queued = limiter.run(async () => 2, controller.signal);

    controller.abort(new Error('cancelled'));
    await expect(queued).rejects.toThrow('cancelled');
    expect(limiter.queued).toBe(0);
    release();
    await active;
  });

  it('removes a queued abort listener when work starts normally', async () => {
    const limiter = new WorkLimiter(1, 1);
    let release!: () => void;
    const active = limiter.run(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const queued = limiter.run(async () => 2, controller.signal);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    release();
    await expect(queued).resolves.toBe(2);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await active;
  });
});
