// Type surface for the (JS) AP escalation-scan daemon's pure schedule helpers, so
// a vitest test can import it under `allowJs: false`. The daemon auto-start is
// guarded behind an entrypoint check, so importing the module is side-effect-free
// (the only consumer of these types is the test).

/**
 * The next UTC instant whose minute-of-hour is `minute` (seconds/ms zeroed),
 * strictly after `from`. Timezone-free by design: an hourly cadence is identical
 * in every zone, so unlike the wall-clock daemons this needs no DST handling.
 */
export function nextHourlyFireInstant(from: Date, minute: number): Date;

/**
 * POST the internal escalation-scan route once. Throws on transport error,
 * redirect (a login 307 is a FAILURE, never followed), or any non-200. Returns
 * the (truncated) response body on 200.
 */
export function runFireOnce(): Promise<string>;

/** Truncate a response body for logging (default 300 chars). */
export function truncateBody(text: string, max?: number): string;
