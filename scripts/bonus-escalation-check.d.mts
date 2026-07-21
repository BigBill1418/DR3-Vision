// Type surface for the (JS) escalation cron daemon's pure schedule helper, so
// the T-205 vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of types here is the test).

/** One of the four escalation fires. */
export type EscalationTier = 't1' | 't2' | 't3' | 't4';

/**
 * The soonest upcoming escalation fire across the four Pacific
 * (America/Los_Angeles) wall-clock times (07:10 t1 / 07:30 t2 / 08:30 t3 /
 * 09:00 t4 — t1 moved from 06:00 per the ADR-0019.1 2026-07-07 amendment),
 * strictly after `from`. DST-correct across the PDT/PST boundary.
 * `delay` is always > 0.
 */
export function nextEscalationFire(from?: Date): { delay: number; tier: EscalationTier };

/**
 * POST the internal escalation-check route once for a tier. Throws on transport
 * error, redirect (a login 307 is a FAILURE, never followed), or any non-200.
 * Returns the (truncated) response body on 200.
 */
export function runTierOnce(tier: EscalationTier): Promise<string>;

/** Truncate a response body for logging (default 300 chars). */
export function truncateBody(text: string, max?: number): string;

/**
 * Publish an app-INDEPENDENT page (direct to ntfy, primary→fallback) that a tier
 * fire failed after all retries. Fingerprinted per (tier, Pacific day). Returns
 * whether a publish succeeded; a no-op returning `false` when the publisher token
 * is unset. `now` (default `new Date()`) fixes the Pacific date for tests.
 */
export function publishFireFailure(tier: EscalationTier, now?: Date): Promise<boolean>;

/** Injectable seams for `fireTierWithRetry` (all default to the real ones). */
export interface FireTierDeps {
  runTier?: (tier: EscalationTier) => Promise<string>;
  publishFailure?: (tier: EscalationTier) => Promise<boolean>;
  wait?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  spacingMs?: number;
}

/**
 * Fire one tier with bounded in-window retry (default 3 attempts / 15min). On
 * success returns early; on the final failure publishes the app-independent
 * fire-failure page. `deps` is injectable so retry/backstop logic is testable
 * without real waits or real ntfy/app calls.
 */
export function fireTierWithRetry(
  tier: EscalationTier,
  deps?: FireTierDeps,
): Promise<{ ok: boolean; attempts: number; paged?: boolean }>;
