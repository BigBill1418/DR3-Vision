// Type surface for the (JS) daily production-report cron daemon's pure schedule
// helpers, so a vitest test can import them under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of these types is the test).

/**
 * The next UTC instant at which the Pacific (America/Los_Angeles) wall clock
 * reads `hour:minute:00`, strictly after `from`. DST-correct across the PDT/PST
 * boundary via the offset-reprobe technique (anchors to the target Pacific
 * calendar day + that day's UTC offset).
 */
export function nextFireInstantAt(from: Date, hour: number, minute: number): Date;

/**
 * Read HH:MM from a `@db.Time` value. Prisma round-trips a TIME column as a Date
 * whose UTC hours/minutes ARE the configured wall clock (no zone).
 */
export function hmFromTime(d: Date): { hour: number; minute: number };

/**
 * POST the internal daily-report route once. Throws on transport error, redirect
 * (a login 307 is a FAILURE, never followed), or any non-200. Returns the
 * (truncated) response body on 200.
 */
export function runFireOnce(): Promise<string>;

/** Truncate a response body for logging (default 300 chars). */
export function truncateBody(text: string, max?: number): string;
