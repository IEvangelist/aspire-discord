import { describe, expect, it } from 'vitest';
import { UserRateLimiter } from '../../src/discord/user-rate-limiter.js';

describe('UserRateLimiter', () => {
  it('limits each user independently within a sliding minute', () => {
    const limiter = new UserRateLimiter(2);

    expect(limiter.acquire('one', 1_000).allowed).toBe(true);
    expect(limiter.acquire('one', 2_000).allowed).toBe(true);
    expect(limiter.acquire('one', 3_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 58,
    });
    expect(limiter.acquire('two', 3_000).allowed).toBe(true);
    expect(limiter.acquire('one', 61_001).allowed).toBe(true);
  });

  it('bounds tracked users and evicts the oldest active entry', () => {
    const limiter = new UserRateLimiter(2, 2);

    expect(limiter.acquire('one', 1).allowed).toBe(true);
    expect(limiter.acquire('two', 2).allowed).toBe(true);
    expect(limiter.acquire('three', 3).allowed).toBe(true);
    expect(limiter.acquire('one', 4).allowed).toBe(true);
  });
});
