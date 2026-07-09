// Type surface for the (JS) AP-approver-expiry cron daemon's pure schedule
// helpers, so a vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of these types is the test).

/**
 * The next UTC instant at which the Pacific (America/Los_Angeles) wall clock
 * reads `hour:minute:00`, strictly at/after `from`. DST-correct across the
 * PDT/PST boundary. If today's hh:mm PT has already passed, it rolls to
 * tomorrow's.
 */
export function nextFireInstantAt(from: Date, hour: number, minute: number): Date;

/**
 * POST the internal expiry route once. Throws on transport error, redirect (a
 * login 307 is a FAILURE, never followed), or any non-200. Returns the
 * (truncated) response body on 200.
 */
export function runFireOnce(): Promise<string>;

/** Truncate a response body for logging (default 300 chars). */
export function truncateBody(text: string, max?: number): string;
