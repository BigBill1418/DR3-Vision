// ADR-0125 — turning a `?day=` query string into a business day key.
//
// One function, used by the page and by every EOD route, so "which day is this
// screen about" has exactly one definition. `time.ts:229-230` states the rule
// this exists to obey: "Do NOT introduce a second day-key definition."
//
// A malformed value is REFUSED, never quietly resolved to today. Silently
// retargeting a mistyped date would render one day's gaps under another day's
// heading, and the close button beneath it would then close the wrong day.

import { appToday, dayKeyUTCFromISO } from '@/lib/time';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Refused because the `?day=` parameter is not a calendar day. */
export class EodDayParamError extends Error {
  readonly status = 422 as const;
  readonly reason = 'invalid_day' as const;
  constructor(raw: string) {
    super(`day must be YYYY-MM-DD (got ${JSON.stringify(raw)})`);
    this.name = 'EodDayParamError';
  }
}

/**
 * Resolve `?day=YYYY-MM-DD` to its @db.Date day key. Absent/empty ⇒ the current
 * PACIFIC business day (`appToday`), never the server's UTC day — the container
 * runs UTC and a server-local "today" becomes tomorrow at 5 PM Pacific, mid-shift.
 */
export function resolveEodDayKey(raw: string | null | undefined, now: Date = new Date()): Date {
  if (raw == null || raw.trim() === '') return appToday(now);
  const value = raw.trim();
  if (!DAY_RE.test(value)) throw new EodDayParamError(value);
  try {
    return dayKeyUTCFromISO(value);
  } catch {
    throw new EodDayParamError(value);
  }
}
