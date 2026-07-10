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
