// Type surface for the (JS) stale-claim watchdog cron daemon's pure schedule helper, so a
// vitest test can import it under `allowJs: false`. The daemon auto-start is
// guarded behind an entrypoint check, so importing the module is side-effect-free
// (the only consumer of these types is `src/__tests__/cron-dst-schedule.test.ts`).

/**
 * The next UTC instant at which the Pacific (America/Los_Angeles) wall clock
 * reads `hour:minute:00`, strictly after `from`. DST-correct across the PDT/PST
 * boundary via the offset-reprobe technique (anchors to the target Pacific
 * calendar day + that day's UTC offset). This daemon fires at 16:45 PT.
 */
export function nextFireInstantAt(from: Date, hour: number, minute: number): Date;

/**
 * POST the internal scan route once. Throws on transport error, redirect (a
 * login 307 is a FAILURE, never followed), or any non-200. Returns the
 * (truncated) response body on 200.
 */
export function runFireOnce(): Promise<string>;

/** Truncate a response body for logging (default 300 chars). */
export function truncateBody(text: string, max?: number): string;
