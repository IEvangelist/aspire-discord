import { AsyncResource } from 'node:async_hooks';

export class WorkQueueFullError extends Error {
  public constructor(maximumQueued: number) {
    super(`The work queue is full (${String(maximumQueued)} waiting requests).`);
    this.name = 'WorkQueueFullError';
  }
}

interface QueueEntry<T> {
  readonly execute: () => Promise<T>;
  onAbort?: () => void;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
  readonly signal?: AbortSignal;
}

export class WorkLimiter {
  readonly #queue: QueueEntry<unknown>[] = [];
  #active = 0;

  public constructor(
    private readonly maximumConcurrency: number,
    private readonly maximumQueued: number,
  ) {
    if (!Number.isSafeInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new RangeError('maximumConcurrency must be at least 1.');
    }
    if (!Number.isSafeInteger(maximumQueued) || maximumQueued < 0) {
      throw new RangeError('maximumQueued cannot be negative.');
    }
  }

  public get active(): number {
    return this.#active;
  }

  public get queued(): number {
    return this.#queue.length;
  }

  public run<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.#active < this.maximumConcurrency) {
      return this.#start(execute);
    }
    if (this.#queue.length >= this.maximumQueued) {
      return Promise.reject(new WorkQueueFullError(this.maximumQueued));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        execute: AsyncResource.bind(execute),
        reject,
        resolve,
        ...(signal ? { signal } : {}),
      };
      this.#queue.push(entry as QueueEntry<unknown>);
      if (signal) {
        const onAbort = () => {
          const index = this.#queue.indexOf(entry as QueueEntry<unknown>);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            reject(abortReason(signal));
          }
        };
        entry.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async #start<T>(execute: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await execute();
    } finally {
      this.#active -= 1;
      this.#drain();
    }
  }

  #drain(): void {
    while (this.#active < this.maximumConcurrency) {
      const entry = this.#queue.shift();
      if (!entry) {
        return;
      }
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      if (entry.signal?.aborted) {
        entry.reject(abortReason(entry.signal));
        continue;
      }
      void this.#start(entry.execute).then(entry.resolve, entry.reject);
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.');
}
