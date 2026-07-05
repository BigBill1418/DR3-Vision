// ADR-0045 D3 — simple in-memory per-IP rate limit for the public intake.
//
// LIMITATION (documented on purpose): this is a fixed-window counter in PROCESS
// memory. It is per-instance (a multi-replica deploy limits per replica, not
// globally) and resets on restart. That is acceptable here — the endpoint is
// token-guarded and honeypotted; the rate limit is hygiene against a single
// noisy source, not a security control. If DR3-Vision ever scales past one
// replica for this route, promote to a shared store (Redis) — noted in the
// operator runbook.

const WINDOW_MS = 60_000; // 1 minute
const MAX_PER_WINDOW = 5; // submissions per IP per window

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** Record a hit for `key` (an IP). Returns whether it is within the window cap. */
export function rateLimit(key: string, now: number = Date.now()): RateLimitResult {
  // Opportunistic sweep so the map never grows unbounded.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_PER_WINDOW - 1, retryAfterSec: 0 };
  }
  existing.count += 1;
  if (existing.count > MAX_PER_WINDOW) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((existing.resetAt - now) / 1000),
    };
  }
  return { allowed: true, remaining: MAX_PER_WINDOW - existing.count, retryAfterSec: 0 };
}

/** Test-only: clear all buckets. */
export function __resetRateLimit(): void {
  buckets.clear();
}
