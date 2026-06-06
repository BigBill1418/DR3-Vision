// Type surface for the (JS) escalation cron daemon's pure schedule helper, so
// the T-205 vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of types here is the test).

/** One of the four escalation fires. */
export type EscalationTier = 't1' | 't2' | 't3' | 't4';

/**
 * The soonest upcoming escalation fire across the four Pacific
 * (America/Los_Angeles) wall-clock times (06:00 t1 / 07:30 t2 / 08:30 t3 /
 * 09:00 t4), strictly after `from`. DST-correct across the PDT/PST boundary.
 * `delay` is always > 0.
 */
export function nextEscalationFire(from?: Date): { delay: number; tier: EscalationTier };
