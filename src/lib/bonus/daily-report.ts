// ADR-0030 — Pure aggregation logic for the daily production report.
//
// Site-scoped: every query is keyed on the siteId the caller (daemon or
// admin route) hands in. CLAUDE.md hard rule #2.
//
// Pacific calendar-day discipline: date inputs are UTC-midnight @db.Date
// keys for the Pacific calendar day.
//
// Pure: no side effects, no notifications. Side effects live in
// daily-report-notifications.ts and the daemon shell.

import { prisma } from '@/lib/prisma';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';
import { getEodInventorySnapshot, type EodInventorySnapshot } from '@/lib/loads/eod-inventory';
import { log } from '@/lib/observability/logger';

export interface ProcessorLine {
  employeeId: string;
  fullName: string;
  mattresses: number;
  bonusCents: number;
  enteredAt: Date;
}

export interface ComparisonTotal {
  /** Pacific day or window represented by this comparison. */
  startDate: Date;
  endDate: Date;
  /** null when zero entries exist in the window → render "no previous data available". */
  total: number | null;
}

/**
 * ADR-0076 — distinct-processor headcounts, mirroring the units' today → MTD →
 * comparison structure (Bill 2026-08-05: worked-that-day + MTD + same period
 * last month + same day last year; all-time explicitly declined).
 *
 * Counts are DISTINCT processors with ≥1 recorded entry in the window — a
 * processor who worked twenty days counts once. They derive from
 * `bonus_daily_entries` only (the payroll source, unique per employee+day) and
 * are NOT reconcilable against the units totals: ADR-0032 reporting adjustments
 * move units with no processor attribution.
 */
export interface ProcessorCounts {
  /** Distinct processors with a recorded entry on the report day (= lines.length). */
  today: number;
  /** Distinct processors with ≥1 entry in [firstOfMonth, reportDate]. */
  mtd: number;
  /** Distinct processors in [firstOfPriorMonth, sameDomPriorMonth]. */
  priorMonthSamePeriod: number;
  /** Distinct processors on the same day last year (single-day window). */
  sameDayLastYear: number;
}

export interface DailyReport {
  siteId: string;
  siteCode: string;
  siteName: string;
  /** UTC-midnight @db.Date key for the Pacific calendar day. */
  reportDate: Date;
  /** Per-employee, sorted by mattress count desc, ties broken by entered_at asc. */
  lines: ProcessorLine[];
  totalToday: number;
  totalBonusCents: number;
  sameDayLastYear: ComparisonTotal;
  mtd: ComparisonTotal;
  priorMonthSamePeriod: ComparisonTotal;
  /** Percentage delta MTD vs prior-month same period. null when prior is 0 or null. */
  paceDeltaPct: number | null;
  /** ADR-0076 — distinct-processor headcounts for the same windows as the units. */
  processorCounts: ProcessorCounts;
  /**
   * ADR-0037 Phase 4 (spec §4) — end-of-day inventory for this site/day, carrying
   * its own freshness state (healthy / stale / zero). `undefined` ONLY when the
   * inventory read failed: the production numbers are the point of this report and
   * must still go out, so an inventory outage drops the section rather than the
   * email. It is never `undefined` to mean "stale" — staleness is a state on the
   * snapshot and renders the warning band.
   */
  eodInventory?: EodInventorySnapshot | undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Date helpers — pure, no IO
// ─────────────────────────────────────────────────────────────────────

function utcDate(y: number, m1: number, d: number): Date {
  return new Date(Date.UTC(y, m1 - 1, d));
}

function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

export function sameDayPriorYear(d: Date): Date {
  const y = d.getUTCFullYear() - 1;
  const m1 = d.getUTCMonth() + 1;
  const dom = d.getUTCDate();
  return utcDate(y, m1, Math.min(dom, daysInMonth(y, m1)));
}

export function firstOfMonth(d: Date): Date {
  return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function firstOfPriorMonth(d: Date): Date {
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  if (m0 === 0) return utcDate(y - 1, 12, 1);
  return utcDate(y, m0, 1);
}

export function sameDomPriorMonth(d: Date): Date {
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const dom = d.getUTCDate();
  const priorY = m0 === 0 ? y - 1 : y;
  const priorM1 = m0 === 0 ? 12 : m0;
  return utcDate(priorY, priorM1, Math.min(dom, daysInMonth(priorY, priorM1)));
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

/**
 * Sum mattress_count across all site-scoped entries with entry_date in [start, end],
 * PLUS any reporting-only production adjustments (ADR-0032) in the same window.
 * Returns null when neither entries nor adjustments exist (lets the renderer show
 * "no previous data available").
 *
 * PRODUCTION-QUANTITY path: this is a units total, so it includes the reporting
 * adjustments. Bonus-DOLLAR paths (per-line bonusCents / totalBonusCents in
 * buildDailyReport) deliberately do NOT — adjustments live in
 * `bonus_reporting_adjustments`, a table no bonus-dollar query touches, so the
 * frozen closed-period payout can never move (ADR-0032).
 */
async function sumRangeOrNull(siteId: string, start: Date, end: Date): Promise<number | null> {
  const [rows, adjustments] = await Promise.all([
    prisma.bonusDailyEntry.findMany({
      where: {
        bonus_employee: { site_id: siteId },
        entry_date: { gte: start, lte: end },
      },
      select: { mattress_count: true },
    }),
    prisma.bonusReportingAdjustment.findMany({
      where: { site_id: siteId, entry_date: { gte: start, lte: end } },
      select: { units: true },
    }),
  ]);
  if (rows.length === 0 && adjustments.length === 0) return null;
  // Floor per-entry (the calculator's canonical reading of a fractional count —
  // see calculateDailyBonusCents) BEFORE summing, so this range total uses the
  // exact same per-row basis as the per-line units in buildDailyReport. This is
  // what guarantees totalToday === MTD on a single-day month (no round-then-sum
  // vs sum-then-round divergence) and keeps unit figures consistent everywhere.
  let sum = 0;
  for (const r of rows) sum += Math.floor(r.mattress_count.toNumber());
  // Adjustment units are already whole signed integers (+add / -subtract).
  for (const a of adjustments) sum += a.units;
  return sum;
}

async function comparisonOrNull(siteId: string, start: Date, end: Date): Promise<ComparisonTotal> {
  return { startDate: start, endDate: end, total: await sumRangeOrNull(siteId, start, end) };
}

// ─────────────────────────────────────────────────────────────────────
// Build the report
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the daily report for `siteId` on the given Pacific calendar day.
 * Throws if the site does not exist. Never throws on missing comparison data —
 * those fields are `null` when their window contains no entries.
 */
/**
 * ADR-0076 — distinct processors with ≥1 entry in [start, end].
 *
 * `groupBy`, NOT `findMany({distinct})`: the daily-report test mock discriminates
 * `bonusDailyEntry.findMany` calls by the shape of `where.entry_date`, so a new
 * findMany variant would silently collide with an existing branch. `groupBy` is
 * its own surface. Exactness comes from the `(bonus_employee_id, entry_date)`
 * unique constraint — no dedupe subtleties exist in the source table.
 */
async function distinctProcessors(siteId: string, start: Date, end: Date): Promise<number> {
  const rows = await prisma.bonusDailyEntry.groupBy({
    by: ['bonus_employee_id'],
    where: {
      bonus_employee: { site_id: siteId },
      entry_date: { gte: start, lte: end },
    },
  });
  return rows.length;
}

export async function buildDailyReport(siteId: string, reportDate: Date): Promise<DailyReport> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, code: true, name: true },
  });
  if (!site) throw new Error(`site ${siteId} not found`);

  // The site's effective bonus rule for the report date governs per-line bonus.
  const rule = await resolveActiveRule(siteId, reportDate);

  // Today's entries (per-employee lines).
  const todayEntries = await prisma.bonusDailyEntry.findMany({
    where: {
      bonus_employee: { site_id: siteId },
      entry_date: reportDate,
    },
    select: {
      mattress_count: true,
      entered_at: true,
      bonus_employee: { select: { id: true, full_name: true } },
    },
  });

  const lines: ProcessorLine[] = todayEntries
    .map((e) => {
      // Floor matches calculateDailyBonusCents' internal floor AND the signed
      // payroll PDF path (month-list.ts passes raw .toNumber() → the calculator
      // floors), so the displayed unit, the bonus basis, and the payroll PDF
      // never diverge — even on the fractional counts ADR-0023 history allows.
      const mattresses = Math.floor(e.mattress_count.toNumber());
      return {
        employeeId: e.bonus_employee.id,
        fullName: e.bonus_employee.full_name,
        mattresses,
        bonusCents: calculateDailyBonusCents(mattresses, rule),
        enteredAt: e.entered_at,
      };
    })
    .sort((a, b) => {
      if (b.mattresses !== a.mattresses) return b.mattresses - a.mattresses;
      return a.enteredAt.getTime() - b.enteredAt.getTime();
    });

  const totalToday = lines.reduce((n, l) => n + l.mattresses, 0);
  const totalBonusCents = lines.reduce((n, l) => n + l.bonusCents, 0);

  // Comparisons. Each is null-on-empty so Eugene renders gracefully.
  const sdlyDate = sameDayPriorYear(reportDate);
  const sameDayLastYear = await comparisonOrNull(siteId, sdlyDate, sdlyDate);

  const mtdStart = firstOfMonth(reportDate);
  // MTD spans [firstOfMonth, reportDate] inclusive. Today is always inside that
  // window, so the single range sum already includes today's entries — no
  // special-case, no double DB call, no double-count. total is null only when
  // the whole month has zero entries (then totalToday is 0 too).
  const mtd = await comparisonOrNull(siteId, mtdStart, reportDate);

  const priorStart = firstOfPriorMonth(reportDate);
  const priorEnd = sameDomPriorMonth(reportDate);
  const priorMonthSamePeriod = await comparisonOrNull(siteId, priorStart, priorEnd);

  // ADR-0037 Phase 4 — EOD inventory, read from the ONE running balance. Degrades
  // to an omitted section (logged, never silent-empty numbers) so an inventory
  // failure can never suppress the production report itself.
  let eodInventory: EodInventorySnapshot | undefined;
  try {
    eodInventory = await getEodInventorySnapshot(siteId, reportDate);
  } catch (err) {
    log.error({ err, siteId }, '[daily-report] EOD inventory unavailable — section omitted');
  }

  const paceDeltaPct =
    priorMonthSamePeriod.total === null || priorMonthSamePeriod.total === 0 || mtd.total === null
      ? null
      : Math.round((mtd.total / priorMonthSamePeriod.total - 1) * 1000) / 10;

  // ADR-0076 — headcounts over the SAME windows the units comparisons use.
  // `today` is free: the (employee, date) unique constraint makes lines.length
  // exactly the day's distinct-processor count.
  const processorCounts: ProcessorCounts = {
    today: lines.length,
    mtd: await distinctProcessors(siteId, mtdStart, reportDate),
    priorMonthSamePeriod: await distinctProcessors(siteId, priorStart, priorEnd),
    sameDayLastYear: await distinctProcessors(siteId, sdlyDate, sdlyDate),
  };

  return {
    siteId: site.id,
    siteCode: site.code,
    siteName: site.name,
    reportDate,
    lines,
    totalToday,
    totalBonusCents,
    sameDayLastYear,
    mtd,
    priorMonthSamePeriod,
    paceDeltaPct,
    processorCounts,
    eodInventory,
  };
}
