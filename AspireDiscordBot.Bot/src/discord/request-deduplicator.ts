const defaultRetentionMilliseconds = 15 * 60_000;
const defaultMaximumEntries = 10_000;

export class RequestDeduplicator {
  readonly #seen = new Map<string, number>();

  public constructor(
    private readonly retentionMilliseconds = defaultRetentionMilliseconds,
    private readonly maximumEntries = defaultMaximumEntries,
  ) {}

  public claim(id: string, now = Date.now()): boolean {
    this.#prune(now);
    const expiresAt = this.#seen.get(id);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    if (expiresAt !== undefined) {
      this.#seen.delete(id);
    }
    this.#seen.set(id, now + this.retentionMilliseconds);
    while (this.#seen.size > this.maximumEntries) {
      const oldest = this.#seen.keys().next();
      if (oldest.done) {
        throw new Error('Request deduplicator size invariant was violated.');
      }
      this.#seen.delete(oldest.value);
    }
    return true;
  }

  #prune(now: number): void {
    for (const [id, expiresAt] of this.#seen) {
      if (expiresAt > now) {
        break;
      }
      this.#seen.delete(id);
    }
  }
}
