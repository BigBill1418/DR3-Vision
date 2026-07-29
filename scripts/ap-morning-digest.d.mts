// Type surface for the (JS) AP morning-digest cron daemon's pure schedule
// helpers, so a vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of these types is the test).

/**
 * The next UTC instant at which the Pacific (America/Los_Angeles) wall clock
 * reads `hour:minute:00`, strictly after `from`. DST-correct across the
 * PDT/PST boundary — 06:00 PT is 13:00 UTC in summer and 14:00 UTC in winter,
 * and this resolves that from the tz database rather than a fixed offset.
 */
export function nextFireInstantAt(from: Date, hour: number, minute: number): Date;

/**
 * POST the internal morning-digest route once. Throws on transport error,
 * redirect (a login 307 is a FAILURE, never followed), or any non-200. Returns
 * the (truncated) response body on 200.
 */
export function runFireOnce(): Promise<string>;

/** Truncate a response body for logging (default 300 chars). */
export function truncateBody(text: string, max?: number): string;
