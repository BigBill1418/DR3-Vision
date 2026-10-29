// ADR-0143 D6 (plan item 7) — the daily split, made visible where it is entered.
//
// Bill, 2026-10-29: the Woodland floor is physically MIXED (B3), so no count can
// measure the program / non-program split, and "a non program unit is always non
// program - the total is what matters not necessarily that specific unit" (B2).
//
// What code can do about the split without deciding a business rule: show the
// person entering a day how many PROGRAM units were available to process, so a
// program figure above it is visibly a mistake before it is saved. A day that still
// goes past it opens an inventory exception (pool-guard.ts) — it is never refused,
// because MRC's record is the system of record.
//
// The written convention for the workbook and MyMRC entry ("record program
// processed only up to the program available that day; the rest is non-program") is
// a business rule awaiting Bill's word (OPEN-ITEMS 0.CH, CH-7). It is NOT enforced.

import { prisma } from '@/lib/prisma';
import { pacificDayISO } from '@/lib/time';
import { computePositionWindow, type PositionRow } from './pool-guard';

export interface ProgramAvailable {
  day: string;
  /** Opening program + program received + drop-offs + approved adjustments that day. */
  units: number;
  /** True when that sum is not above zero: there is no program to process. */
  none: boolean;
}

/** Pure: program units available to process on the day of `row` (a program row). */
export function programAvailableFromRow(row: PositionRow): ProgramAvailable {
  const units = row.opening.plus(row.inbound).plus(row.dropoffs).plus(row.adjustments).toNumber();
  return { day: row.day, units: Math.max(units, 0), none: units <= 0 };
}

/** Today's program availability at a site (Pacific day), or null with no window yet. */
export async function programAvailableToday(
  siteId: string,
  now: Date = new Date(),
): Promise<ProgramAvailable | null> {
  const win = await computePositionWindow(prisma, siteId, now);
  const today = pacificDayISO(now);
  const row = win.rows.find((r) => r.pool === 'program' && r.day === today);
  return row ? programAvailableFromRow(row) : null;
}
