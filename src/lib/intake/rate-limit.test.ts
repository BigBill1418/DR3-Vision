import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRateLimit, rateLimit } from './rate-limit';

beforeEach(() => __resetRateLimit());

describe('rateLimit — per-IP fixed window', () => {
  it('allows up to the cap then blocks with a retry-after', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(rateLimit('1.2.3.4', now).allowed).toBe(true);
    }
    const blocked = rateLimit('1.2.3.4', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('separate IPs have independent buckets', () => {
    const now = 2_000_000;
    for (let i = 0; i < 5; i++) rateLimit('a', now);
    expect(rateLimit('a', now).allowed).toBe(false);
    expect(rateLimit('b', now).allowed).toBe(true);
  });

  it('resets after the window elapses', () => {
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) rateLimit('c', now);
    expect(rateLimit('c', now).allowed).toBe(false);
    expect(rateLimit('c', now + 61_000).allowed).toBe(true);
  });
});
