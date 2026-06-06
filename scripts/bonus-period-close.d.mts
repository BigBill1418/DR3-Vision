// Type surface for the (JS) period-close cron daemon's pure schedule helper,
// so the T-204 vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of types here is the test).

/**
 * Milliseconds from `from` until the next instant whose Pacific
 * (America/Los_Angeles) wall clock reads 17:30:00. DST-correct across the
 * PDT/PST boundary. Always > 0.
 */
export function msUntilNext1730Pacific(from?: Date): number;
