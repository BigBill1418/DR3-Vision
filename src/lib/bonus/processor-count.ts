// ADR-0076 follow-up (OPEN-ITEMS 0.AG F-1) — the CANONICAL distinct-processor count.
//
// This module is the shared, canonical implementation of "how many DISTINCT people
// processed at this site in this window". It is the only copy any NEW caller should
// import.
//
// ── Why this module exists at all ────────────────────────────────────────────
// `src/lib/bonus/daily-report.ts` already carried this exact query as a
// module-PRIVATE helper (`distinctProcessors`) when the COR pre-fill needed the same
// figure. That private twin is NOT exported and `daily-report.ts` was off-limits to
// the change that created this file (its behaviour — the 20:00 PT production report
// — must not move), so the query was lifted here rather than exported from there.
//
// **The duplication is deliberate and temporary.** `daily-report.ts` still carries
// its private twin. The next time that file is legitimately touched, collapse it onto
// this module: delete the private `distinctProcessors`, import
// `countDistinctProcessors` from here, and re-run the daily-report suite. That
// collapse was explicitly OUT OF SCOPE for the change that created this file — do not
// bundle it into unrelated work either.
//
// If you change the semantics below, you are changing them for the COR — a filed
// regulatory document. Change the twin in the same commit or you have forked the
// number that a filing and an operations email both claim to report.
//
// ── Semantics (identical to the daily-report twin, by construction) ──────────
// Counts DISTINCT `bonus_employee_id`s with at least one `bonus_daily_entries` row
// in the INCLUSIVE window [start, end], scoped to the site through the
// `bonus_employee` relation. A processor who worked twenty days in the window counts
// ONCE.
//
// Exactness is structural, not statistical: `bonus_daily_entries` is unique on
// `(bonus_employee_id, entry_date)` (see prisma/schema.prisma), so there are no
// dedupe subtleties in the source table — a day's row count IS its headcount.
// ADR-0076 verified `count(*) === count(distinct bonus_employee_id)` on every
// production day 2026-07-22 → 2026-08-04.
//
// `groupBy`, NOT `findMany({ distinct })` — carried over verbatim from the twin: the
// daily-report test mock discriminates `bonusDailyEntry.findMany` calls by the shape
// of `where.entry_date`, so a new `findMany` variant would silently collide with an
// existing branch. `groupBy` is its own surface.
//
// `start`/`end` are UTC-midnight `@db.Date` day keys for Pacific calendar days — the
// fleet-wide convention for this table. Passing a mid-day `Date` for `end` still
// works (dates are stored at UTC midnight, so `lte` a later instant on the same day
// includes it), but callers should pass day keys so the window is self-describing.
//
// ── What this function does NOT do ───────────────────────────────────────────
// It does not translate a failure into a number. If the query throws, it throws:
// zero is a claim about the world and a broken database is not entitled to make it.
// Callers that must degrade (the COR pre-fill does) decide that for themselves and
// record it in their own provenance — see `src/lib/cor/prefill.ts`.

import { prisma } from '@/lib/prisma';

/**
 * Distinct processors with ≥1 bonus entry at `siteId` in the inclusive window
 * [`start`, `end`].
 *
 * Returns a genuine `0` when the site recorded no entries in the window — that is a
 * real measurement ("nobody processed"), not a missing one. This function never
 * returns `null`; an unreadable source rejects rather than resolving.
 */
export async function countDistinctProcessors(
  siteId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await prisma.bonusDailyEntry.groupBy({
    by: ['bonus_employee_id'],
    where: {
      bonus_employee: { site_id: siteId },
      entry_date: { gte: start, lte: end },
    },
  });
  return rows.length;
}
