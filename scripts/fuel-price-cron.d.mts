// Type surface for the (JS) weekly fuel-price fetch cron daemon's pure schedule
// helper, so a vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of these types is the test).

/**
 * The next UTC instant at which the Pacific (America/Los_Angeles) wall clock
 * reads `weekday hour:minute:00` (weekday: 0=Sun … 6=Sat), strictly after
 * `from`. DST-correct across the PDT/PST boundary via the offset-reprobe
 * technique (anchors to the target Pacific calendar day + that day's UTC offset).
 */
export function nextWeeklyFireInstant(
  from: Date,
  weekday: number,
  hour: number,
  minute: number,
): Date;

/**
 * POST the internal fuel-fetch route once. Throws on transport error, redirect
 * (a login 307 is a FAILURE, never followed), or any non-200. Returns the
 * (truncated) response body on 200.
 */
export function runFireOnce(): Promise<string>;

/** Truncate a response body for logging (default 300 chars). */
export function truncateBody(text: string, max?: number): string;
