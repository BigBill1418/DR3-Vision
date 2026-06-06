// ADR-0019 §8 — Historical bonus-month browsing data layer (T-117).
//
// Read-only data layer behind the /bonus/months list page. Every public
// function here:
//   - assumes the caller already passed `requireBonusAccess()` (the page /
//     route layer enforces the Woodland gate; never trust the client). Callers
//     pass the Woodland `siteId` from the BonusContext and EVERY query is
//     scoped by it (CLAUDE.md hard rule #2 — bonus is Woodland-only in V2). A
//     forged/cross-site id can never surface another site's months.
//   - is strictly read-only: this module performs NO mutations and writes NO
//     audit rows. State changes go through `@/lib/bonus/state-machine`.
//
// Per-month payout is the locked `total_payout_cents` when the month has one
// (computed and frozen at signature time per ADR-0019 §7). For months that have
// not yet locked a total (draft / pre-signature, or legacy rows), we fall back
// to computing from the keyed daily entries through the shared
// `@/lib/bonus/calculator` with each month's effective rule (CLAUDE.md hard
// rule #3 — bonus math is never hardcoded and never diverges from the PDF/CSV).

import { prisma } from '@/lib/prisma';
import { resolveActiveRule, NoActiveRuleError } from '@/lib/bonus/daily-entry';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';
import type { BonusMonthState } from '@/lib/bonus/state-machine';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/**
 * The three browsing filters offered on the list page (ADR-0019 §8):
 *   - `current` — the current UTC calendar month only.
 *   - `year`    — every month in the current UTC calendar year.
 *   - `all`     — all-time, no date bound.
 */
export type MonthFilter = 'current' | 'year' | 'all';

export const MONTH_FILTERS: readonly MonthFilter[] = ['current', 'year', 'all'];

/** Narrow an arbitrary string (e.g. a search param) to a {@link MonthFilter}. */
export function parseMonthFilter(value: string | null | undefined): MonthFilter {
  return value === 'year' || value === 'all' ? value : 'current';
}

/** Coarse signature progress for a month, derived from the two signer columns. */
export type SignatureStatus = 'none' | 'partial' | 'complete';

export interface MonthListRow {
  id: string;
  /** UTC-midnight first day of the month (matches the `@db.Date` column). */
  monthStart: Date;
  /** "September 2026", en-US, rendered in UTC to match the stored calendar day. */
  label: string;
  state: BonusMonthState;
  /** Total payout in integer CENTS (locked total, else computed from entries). */
  totalPayoutCents: number;
  /** Whether `totalPayoutCents` came from the frozen locked column vs. computed. */
  totalIsLocked: boolean;
  /** Signature progress (independent of the lifecycle state). */
  signatureStatus: SignatureStatus;
  janetteSigned: boolean;
  morenaSigned: boolean;
  /** True iff this month was produced by amending an earlier month (§6). */
  isAmendment: boolean;
  /** The prior month this one amends, if any — for the "view prior version" link. */
  amendedFromMonthId: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Date window helpers (UTC, zone-safe for @db.Date)
// ────────────────────────────────────────────────────────────────────

interface DateWindow {
  gte?: Date;
  lt?: Date;
}

/**
 * Build the `month_start` range for a filter, anchored on `now` (defaults to the
 * wall clock; injectable for deterministic tests). All bounds are UTC-midnight
 * so they line up with the `@db.Date` column.
 */
export function monthWindow(filter: MonthFilter, now: Date = new Date()): DateWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (filter === 'current') {
    return {
      gte: new Date(Date.UTC(y, m, 1)),
      lt: new Date(Date.UTC(y, m + 1, 1)),
    };
  }
  if (filter === 'year') {
    return {
      gte: new Date(Date.UTC(y, 0, 1)),
      lt: new Date(Date.UTC(y + 1, 0, 1)),
    };
  }
  return {}; // all-time
}

function monthLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

function signatureStatus(janette: boolean, morena: boolean): SignatureStatus {
  if (janette && morena) return 'complete';
  if (janette || morena) return 'partial';
  return 'none';
}

// ────────────────────────────────────────────────────────────────────
// Per-month payout (locked total, else computed from entries)
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve the payout for one month, in integer cents. Prefers the frozen
 * `total_payout_cents` (locked at signature time); otherwise sums the keyed
 * daily entries through the shared calculator with the month's effective rule.
 * Returns `{ cents, locked }`. A month with no active rule AND no locked total
 * resolves to 0 (a pre-rule/empty draft) rather than throwing — browsing must
 * never 500 on a half-set-up month.
 */
async function payoutForMonth(
  siteId: string,
  month: { id: string; month_start: Date; total_payout_cents: number | null },
): Promise<{ cents: number; locked: boolean }> {
  if (month.total_payout_cents !== null) {
    return { cents: month.total_payout_cents, locked: true };
  }
  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_month_id: month.id },
    select: { mattress_count: true },
  });
  if (entries.length === 0) return { cents: 0, locked: false };
  let rule;
  try {
    rule = await resolveActiveRule(siteId, month.month_start);
  } catch (e) {
    if (e instanceof NoActiveRuleError) return { cents: 0, locked: false };
    throw e;
  }
  let cents = 0;
  for (const e of entries) cents += calculateDailyBonusCents(e.mattress_count, rule);
  return { cents, locked: false };
}

// ────────────────────────────────────────────────────────────────────
// listBonusMonths — the filtered, site-scoped list
// ────────────────────────────────────────────────────────────────────

/**
 * List Woodland bonus months for `filter`, newest-first, each with its payout
 * total, signature status, and amendment linkage. Site-scoped (hard rule #2).
 * `now` is injectable for deterministic tests.
 */
export async function listBonusMonths(
  siteId: string,
  filter: MonthFilter,
  now: Date = new Date(),
): Promise<MonthListRow[]> {
  const win = monthWindow(filter, now);
  const where: { site_id: string; month_start?: { gte?: Date; lt?: Date } } = { site_id: siteId };
  if (win.gte || win.lt) {
    where.month_start = {};
    if (win.gte) where.month_start.gte = win.gte;
    if (win.lt) where.month_start.lt = win.lt;
  }

  const months = await prisma.bonusMonth.findMany({
    where,
    orderBy: { month_start: 'desc' },
    select: {
      id: true,
      month_start: true,
      state: true,
      total_payout_cents: true,
      janette_signed_by_user_id: true,
      morena_signed_by_user_id: true,
      amended_from_month_id: true,
    },
  });

  const rows: MonthListRow[] = [];
  for (const m of months) {
    const janetteSigned = m.janette_signed_by_user_id !== null;
    const morenaSigned = m.morena_signed_by_user_id !== null;
    const payout = await payoutForMonth(siteId, m);
    rows.push({
      id: m.id,
      monthStart: m.month_start,
      label: monthLabel(m.month_start),
      state: m.state as BonusMonthState,
      totalPayoutCents: payout.cents,
      totalIsLocked: payout.locked,
      signatureStatus: signatureStatus(janetteSigned, morenaSigned),
      janetteSigned,
      morenaSigned,
      isAmendment: m.amended_from_month_id !== null,
      amendedFromMonthId: m.amended_from_month_id ?? null,
    });
  }
  return rows;
}
