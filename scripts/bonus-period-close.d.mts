// Type surface for the (JS) period-close cron daemon's pure schedule helper,
// so the T-204 vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of types here is the test).

/**
 * Milliseconds from `from` until the next instant whose Pacific
 * (America/Los_Angeles) wall clock reads 07:00:00 (ADR-0019.1 2026-07-07
 * amendment — close on the payroll day). DST-correct across the PDT/PST
 * boundary. Always > 0.
 */
export function msUntilNext0700Pacific(from?: Date): number;
