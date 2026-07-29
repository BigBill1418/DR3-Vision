// Type surface for the (JS) document-ingestion delta-sweep daemon, so a vitest
// test can import it under `allowJs: false`. The daemon auto-start is guarded
// behind an entrypoint check, so importing the module is side-effect-free.

/**
 * POST the internal sweep route once. Throws on transport error, on a redirect
 * (a login 307 is a FAILURE and is never followed — see the daemon header), or
 * on any non-200. Returns the truncated response body on 200.
 */
export function runFireOnce(): Promise<string>;

/** Truncate a response body for logging (default 400 chars). */
export function truncateBody(text: string, max?: number): string;

/** Resolved sweep interval in milliseconds. */
export const INTERVAL_MS: number;
