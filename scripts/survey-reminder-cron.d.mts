// Type surface for the (JS) survey-reminder cron daemon's pure schedule helper,
// so the ADR-0036 vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of types here is the test).

/**
 * The next UTC instant at which the Pacific (America/Los_Angeles) wall clock
 * reads `hour:minute:00`, strictly at/after `from`. DST-correct across the
 * PDT/PST boundary. If today's hh:mm PT has already passed, it rolls to
 * tomorrow's.
 */
export function nextFireInstantAt(from: Date, hour: number, minute: number): Date;
