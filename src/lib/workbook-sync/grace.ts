// ADR-0049 Am.4 B1 — the prior-month GRACE WINDOW.
//
// ── The defect this closes ──────────────────────────────────────────────────
// D5 rollover is automatic: on the 1st, `resolveMonthlyFileName` expands the
// naming pattern against the CURRENT Pacific month and the sync starts reading
// the new file. Nothing ever reads the old one again.
//
// That is wrong, because a monthly daily-log workbook is not finished on the
// last day of its month. Kelsey closes the month in the days AFTER it — a
// missed day gets filled in, a mis-keyed figure gets corrected, the final
// day's close gets completed the next morning. Under pure rollover every one
// of those edits is invisible to Vision, permanently. There is no error, no
// ledger row, no alarm: the corrected file simply stops being looked at. It is
// the same shape this codebase keeps producing — "I stopped reading this" and
// "there is nothing more to read" recorded identically.
//
// So for a bounded window into the new month, the PRIOR month's workbook keeps
// being polled alongside the current one.
//
// ── Why the window is bounded, and bounded by BUSINESS days ─────────────────
// An unbounded window means an accidental edit to a February file in November
// silently rewrites February. The window has to close, and once it closes the
// period is closed — a correction after that is a human decision (a superseding
// invoice), not something a poller does behind everyone's back.
//
// Business days rather than calendar days because the thing being waited for is
// human work. A 5-calendar-day window that opens on a Friday gives one working
// day; five business days always gives five.
//
// Holidays are NOT modelled. The effect of that is bounded and in the safe
// direction — a holiday inside the window costs at most one working day of
// grace, it never extends the window past the 5th business day. Adding a
// holiday calendar means maintaining one, and a stale holiday table would make
// the window silently WRONG rather than merely short.
//
// ── What the window does NOT do ────────────────────────────────────────────
// It does not overwrite a day that has already been invoiced. See
// `billedDaysFor` — those days are skipped and reported, never silently
// rewritten. An approved invoice has left the building; changing the figures
// underneath it produces a Vision that disagrees with what MRC was sent, which
// is worse than a correction that waits for a human.

import type { Prisma, PrismaClient } from '@prisma/client';
import { pacificDayISO } from '@/lib/time';

type Db = PrismaClient | Prisma.TransactionClient;

/** Business days into the new month during which the prior month stays readable. */
export const GRACE_BUSINESS_DAYS = 5;

/**
 * Calendar weekday of a Y-M-D, 0=Sunday … 6=Saturday.
 *
 * Deliberately computed in UTC: the weekday of "3 August 2026" is a property of
 * the calendar, not of a time zone. Building the probe in local time is how a
 * date lands on the wrong side of midnight and the whole window shifts a day.
 */
function weekdayOf(year: number, month0: number, day: number): number {
  return new Date(Date.UTC(year, month0, day)).getUTCDay();
}

/** Day-of-month of the `n`th business day (Mon–Fri) of the given month. */
export function nthBusinessDayOfMonth(year: number, month0: number, n: number): number {
  let seen = 0;
  for (let day = 1; day <= 31; day += 1) {
    // Rolled past the end of the month (Date normalises 31 Feb into March).
    if (new Date(Date.UTC(year, month0, day)).getUTCMonth() !== month0) break;
    const wd = weekdayOf(year, month0, day);
    if (wd >= 1 && wd <= 5) {
      seen += 1;
      if (seen === n) return day;
    }
  }
  // Unreachable for n <= 20 — every month has at least 20 business days. Falling
  // back to the last day of the month keeps the window OPEN rather than silently
  // closing it, which is the recoverable direction.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** `{ year, month0, day }` for `at` in Pacific, via the audited day helper. */
function pacificParts(at: Date): { year: number; month0: number; day: number } {
  const [y, m, d] = pacificDayISO(at).split('-').map(Number) as [number, number, number];
  return { year: y, month0: m - 1, day: d };
}

/**
 * Is the prior month still in its grace window at `at` (Pacific)?
 *
 * True from the 1st of the month through the end of the `businessDays`th
 * business day, inclusive.
 */
export function isGraceWindowOpen(at: Date, businessDays: number = GRACE_BUSINESS_DAYS): boolean {
  const { year, month0, day } = pacificParts(at);
  return day <= nthBusinessDayOfMonth(year, month0, businessDays);
}

/**
 * An instant that unambiguously falls inside the PRIOR Pacific month, suitable
 * for feeding `resolveMonthlyFileName` / `pacificYearMonthKey`.
 *
 * The 15th at 20:00 UTC is midday Pacific in both PDT and PST — nowhere near a
 * month boundary in any offset, so no DST edge can push it into a neighbouring
 * month. Anchoring on "now minus 30 days" is the version of this that breaks in
 * March and in a 31-day month.
 */
export function priorMonthAnchor(at: Date): Date {
  const { year, month0 } = pacificParts(at);
  return new Date(Date.UTC(year, month0 - 1, 15, 20, 0, 0));
}

/**
 * The subset of `dayISOs` already covered by an APPROVED invoice for this site.
 *
 * Draft invoices do not count — a draft has been shown to nobody and is
 * regenerated from current figures. Voided invoices do not count either; a void
 * is the explicit statement that the invoice no longer stands.
 *
 * Returns UTC day-key ISO strings ('YYYY-MM-DD'), matching
 * `DailyProductionRow.productionDate`.
 */
export async function billedDaysFor(
  db: Db,
  siteId: string,
  dayISOs: readonly string[],
): Promise<Set<string>> {
  const billed = new Set<string>();
  if (dayISOs.length === 0) return billed;

  const sorted = [...dayISOs].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const invoices = await db.invoice.findMany({
    where: {
      site_id: siteId,
      status: 'approved',
      voided_at: null,
      window_start: { lte: new Date(`${last}T00:00:00.000Z`) },
      window_end: { gte: new Date(`${first}T00:00:00.000Z`) },
    },
    select: { window_start: true, window_end: true },
  });
  if (invoices.length === 0) return billed;

  for (const iso of dayISOs) {
    const key = new Date(`${iso}T00:00:00.000Z`).getTime();
    for (const inv of invoices) {
      if (key >= inv.window_start.getTime() && key <= inv.window_end.getTime()) {
        billed.add(iso);
        break;
      }
    }
  }
  return billed;
}
