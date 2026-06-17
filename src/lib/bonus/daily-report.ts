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
 * Sum mattress_count across all site-scoped entries with entry_date in [start, end].
 * Returns null when zero rows match (lets the renderer show "no previous data available").
 */
async function sumRangeOrNull(siteId: string, start: Date, end: Date): Promise<number | null> {
  const rows = await prisma.bonusDailyEntry.findMany({
    where: {
      bonus_employee: { site_id: siteId },
      entry_date: { gte: start, lte: end },
    },
    select: { mattress_count: true },
  });
  if (rows.length === 0) return null;
  let sum = 0;
  for (const r of rows) sum += r.mattress_count.toNumber();
  return Math.round(sum);
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
      const mattresses = Math.round(e.mattress_count.toNumber());
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
  const mtd: ComparisonTotal = {
    startDate: mtdStart,
    endDate: reportDate,
    // MTD includes today; "no data" only when this month has zero entries.
    total:
      totalToday === 0
        ? await sumRangeOrNull(siteId, mtdStart, reportDate)
        : ((await sumRangeOrNull(siteId, mtdStart, reportDate)) ?? totalToday),
  };

  const priorStart = firstOfPriorMonth(reportDate);
  const priorEnd = sameDomPriorMonth(reportDate);
  const priorMonthSamePeriod = await comparisonOrNull(siteId, priorStart, priorEnd);

  const paceDeltaPct =
    priorMonthSamePeriod.total === null || priorMonthSamePeriod.total === 0 || mtd.total === null
      ? null
      : Math.round((mtd.total / priorMonthSamePeriod.total - 1) * 1000) / 10;

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
  };
}
