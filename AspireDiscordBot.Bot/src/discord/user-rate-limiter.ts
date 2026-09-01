const windowMilliseconds = 60_000;
const defaultMaximumTrackedUsers = 10_000;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export class UserRateLimiter {
  readonly #requests = new Map<string, number[]>();

  public constructor(
    private readonly maximumRequests: number,
    private readonly maximumTrackedUsers = defaultMaximumTrackedUsers,
  ) {}

  public acquire(userId: string, now = Date.now()): RateLimitDecision {
    const cutoff = now - windowMilliseconds;
    const recent = (this.#requests.get(userId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.maximumRequests) {
      const retryAt = (recent[0] ?? now) + windowMilliseconds;
      this.#requests.set(userId, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000)),
      };
    }
    recent.push(now);
    this.#requests.delete(userId);
    this.#requests.set(userId, recent);
    this.#prune(cutoff);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  #prune(cutoff: number): void {
    for (const [userId, requests] of this.#requests) {
      if (this.#requests.size <= this.maximumTrackedUsers) {
        break;
      }
      if ((requests.at(-1) ?? 0) <= cutoff) {
        this.#requests.delete(userId);
      }
    }
    while (this.#requests.size > this.maximumTrackedUsers) {
      const oldest = this.#requests.keys().next();
      if (oldest.done) {
        throw new Error('User rate limiter size invariant was violated.');
      }
      this.#requests.delete(oldest.value);
    }
  }
}
