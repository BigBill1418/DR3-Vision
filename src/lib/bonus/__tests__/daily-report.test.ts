// ADR-0030 §10.1 — Daily production report pure-aggregation tests.
//
// DB-free: mocks `@/lib/prisma` (site.findUnique + bonusDailyEntry.findMany) and
// `@/lib/bonus/daily-entry` (resolveActiveRule), and drives the REAL aggregation
// in `daily-report.ts` against the REAL `@/lib/bonus/calculator`.
//
// The exported date helpers are pure → tested directly. buildDailyReport is fed
// controlled rows: `mattress_count` is a Decimal-like `{ toNumber() }` object to
// mimic the Prisma Decimal(5,1) read boundary.
//
// findMany is called four ways by buildDailyReport:
//   1. today's per-employee lines  → where.entry_date is a bare Date
//   2/3/4. comparison range sums   → where.entry_date is { gte, lte }
// The mock distinguishes the two shapes: bare-Date returns the controlled "today"
// rows; a range returns history rows whose entry_date falls in [gte, lte].

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sameDayPriorYear,
  firstOfMonth,
  firstOfPriorMonth,
  sameDomPriorMonth,
} from '../daily-report';

// ── Decimal mock helper (mimics Prisma Decimal read boundary) ───────
const dec = (n: number) => ({ toNumber: () => n });

const WOODLAND = 'site-woodland';

// Woodland rule (ADR-0019 §1): threshold_low=50 @ $0.50, threshold_high=74 @ $0.25.
const WOODLAND_RULE = {
  id: 'rule-wo',
  effective_date: new Date(Date.UTC(2026, 0, 1)),
  threshold_low: 50,
  rate_low: '0.5000',
  threshold_high: 74,
  rate_high: '0.2500',
};

// ── Controlled fixtures, mutated per-test before calling buildDailyReport ──
interface TodayRow {
  mattress_count: { toNumber(): number };
  entered_at: Date;
  bonus_employee: { id: string; full_name: string };
}
interface HistoryRow {
  entry_date: Date;
  mattress_count: { toNumber(): number };
  /** ADR-0076 — employee identity for distinct-headcount tests. Optional so the
   *  pre-existing sum fixtures stay untouched (each anonymous row counts as its
   *  own synthetic employee). */
  bonus_employee_id?: string;
}
// ADR-0032: reporting-only production adjustments (signed unit deltas keyed by day).
interface AdjustmentRow {
  entry_date: Date;
  units: number;
}

let siteRow: { id: string; code: string; name: string } | null;
let todayRows: TodayRow[];
let historyRows: HistoryRow[];
let adjustmentRows: AdjustmentRow[];

// ADR-0037 Phase 4: buildDailyReport also reads EOD inventory. That path has its
// own tests (src/lib/loads/eod-inventory.test.ts); here it is stubbed so these
// aggregation tests stay DB-free and unchanged in scope.
let eodSnapshot: unknown = null;
let eodThrows = false;
vi.mock('@/lib/loads/eod-inventory', () => ({
  getEodInventorySnapshot: vi.fn(async () => {
    if (eodThrows) throw new Error('inventory down');
    return eodSnapshot;
  }),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/bonus/daily-entry', () => ({
  resolveActiveRule: vi.fn(async () => WOODLAND_RULE),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn(async () => (siteRow ? { ...siteRow } : null)),
    },
    bonusDailyEntry: {
      findMany: vi.fn(
        async ({ where }: { where: { entry_date: Date | { gte: Date; lte: Date } } }) => {
          const ed = where.entry_date as Date | { gte: Date; lte: Date };
          // Range query (comparison sum): { gte, lte }.
          if (ed && typeof ed === 'object' && 'gte' in ed) {
            const { gte, lte } = ed as { gte: Date; lte: Date };
            return historyRows
              .filter(
                (r) =>
                  r.entry_date.getTime() >= gte.getTime() &&
                  r.entry_date.getTime() <= lte.getTime(),
              )
              .map((r) => ({ mattress_count: r.mattress_count }));
          }
          // Bare-Date query: today's per-employee lines.
          return todayRows.map((r) => ({ ...r }));
        },
      ),
      // ADR-0076 — distinct-processor counts. Deliberately a SEPARATE surface
      // from findMany: the findMany mock discriminates on where.entry_date
      // shape, and a distinct query would collide with an existing branch.
      // Faithful to Prisma semantics: groups by the REQUESTED `by` keys, so an
      // implementation that accidentally groups by (employee, date) — counting
      // entries instead of people — goes red rather than passing by mock fiat.
      groupBy: vi.fn(
        async ({
          by,
          where,
        }: {
          by: string[];
          where: { entry_date?: { gte: Date; lte: Date } };
        }) => {
          const ed = where.entry_date;
          const inWindow = ed
            ? historyRows.filter(
                (r) =>
                  r.entry_date.getTime() >= ed.gte.getTime() &&
                  r.entry_date.getTime() <= ed.lte.getTime(),
              )
            : historyRows;
          const keyOf = (r: HistoryRow) =>
            by
              .map((k) =>
                k === 'bonus_employee_id'
                  ? (r.bonus_employee_id ?? `anon-${historyRows.indexOf(r)}`)
                  : String(r.entry_date.getTime()),
              )
              .join('|');
          const groups = new Set(inWindow.map(keyOf));
          return [...groups].map((key) => ({ bonus_employee_id: key.split('|')[0] }));
        },
      ),
    },
    // ADR-0032: production-quantity range sums also pull reporting adjustments.
    // Only called with a { gte, lte } range (sumRangeOrNull).
    bonusReportingAdjustment: {
      findMany: vi.fn(async ({ where }: { where: { entry_date: { gte: Date; lte: Date } } }) => {
        const { gte, lte } = where.entry_date;
        return adjustmentRows
          .filter(
            (r) =>
              r.entry_date.getTime() >= gte.getTime() && r.entry_date.getTime() <= lte.getTime(),
          )
          .map((r) => ({ units: r.units }));
      }),
    },
  },
}));

beforeEach(() => {
  eodSnapshot = null;
  eodThrows = false;
  siteRow = { id: WOODLAND, code: 'woodland', name: 'Woodland' };
  todayRows = [];
  historyRows = [];
  adjustmentRows = [];
});

// Import buildDailyReport AFTER the mocks are registered.
async function build(reportDate: Date) {
  const { buildDailyReport } = await import('../daily-report');
  return buildDailyReport(WOODLAND, reportDate);
}

// ── Date helpers (pure) ─────────────────────────────────────────────

describe('sameDayPriorYear', () => {
  it('clamps Feb 29 to Feb 28 in a non-leap prior year', () => {
    // 2024-02-29 → 2023 is not a leap year → Feb 28.
    expect(sameDayPriorYear(new Date(Date.UTC(2024, 1, 29)))).toEqual(
      new Date(Date.UTC(2023, 1, 28)),
    );
  });

  it('returns the same month/day one year earlier in the ordinary case', () => {
    expect(sameDayPriorYear(new Date(Date.UTC(2026, 5, 16)))).toEqual(
      new Date(Date.UTC(2025, 5, 16)),
    );
  });
});

describe('firstOfMonth', () => {
  it('returns day 1 of the same month', () => {
    expect(firstOfMonth(new Date(Date.UTC(2026, 5, 16)))).toEqual(new Date(Date.UTC(2026, 5, 1)));
  });
});

describe('firstOfPriorMonth', () => {
  it('returns day 1 of the prior month', () => {
    expect(firstOfPriorMonth(new Date(Date.UTC(2026, 5, 16)))).toEqual(
      new Date(Date.UTC(2026, 4, 1)),
    );
  });

  it('crosses the year boundary from January to December', () => {
    expect(firstOfPriorMonth(new Date(Date.UTC(2026, 0, 9)))).toEqual(
      new Date(Date.UTC(2025, 11, 1)),
    );
  });
});

describe('sameDomPriorMonth', () => {
  it('returns the same day-of-month one month earlier', () => {
    expect(sameDomPriorMonth(new Date(Date.UTC(2026, 5, 16)))).toEqual(
      new Date(Date.UTC(2026, 4, 16)),
    );
  });

  it('clamps day 31 to the last day of a shorter prior month', () => {
    // 2026-03-31 → February (28 days, non-leap) → Feb 28.
    expect(sameDomPriorMonth(new Date(Date.UTC(2026, 2, 31)))).toEqual(
      new Date(Date.UTC(2026, 1, 28)),
    );
  });

  it('clamps day 31 to Feb 29 in a leap year', () => {
    // 2024-03-31 → February 2024 (leap, 29 days) → Feb 29.
    expect(sameDomPriorMonth(new Date(Date.UTC(2024, 2, 31)))).toEqual(
      new Date(Date.UTC(2024, 1, 29)),
    );
  });

  it('crosses the year boundary from January to December', () => {
    expect(sameDomPriorMonth(new Date(Date.UTC(2026, 0, 15)))).toEqual(
      new Date(Date.UTC(2025, 11, 15)),
    );
  });
});

// ── buildDailyReport ────────────────────────────────────────────────

const REPORT_DATE = new Date(Date.UTC(2026, 5, 16)); // 2026-06-16

describe('buildDailyReport — happy path', () => {
  it('returns three lines sorted by units desc, ties broken by entered_at asc', async () => {
    todayRows = [
      // Two tied at 60: Carol entered before Bob → Carol must precede Bob.
      {
        mattress_count: dec(60),
        entered_at: new Date('2026-06-16T10:00:00Z'),
        bonus_employee: { id: 'emp-bob', full_name: 'Bob' },
      },
      {
        mattress_count: dec(79),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
      {
        mattress_count: dec(60),
        entered_at: new Date('2026-06-16T08:00:00Z'),
        bonus_employee: { id: 'emp-carol', full_name: 'Carol' },
      },
    ];
    const report = await build(REPORT_DATE);

    expect(report.siteCode).toBe('woodland');
    expect(report.siteName).toBe('Woodland');
    expect(report.lines.map((l) => l.fullName)).toEqual(['Amy', 'Carol', 'Bob']);
    expect(report.totalToday).toBe(199);
  });
});

describe('buildDailyReport — per-line bonus matches the calculator', () => {
  it('computes bonusCents via the resolved rule for each line', async () => {
    const { calculateDailyBonusCents } = await import('../calculator');
    todayRows = [
      {
        mattress_count: dec(79),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
      {
        mattress_count: dec(60),
        entered_at: new Date('2026-06-16T10:00:00Z'),
        bonus_employee: { id: 'emp-bob', full_name: 'Bob' },
      },
    ];
    const report = await build(REPORT_DATE);

    const amy = report.lines.find((l) => l.fullName === 'Amy')!;
    const bob = report.lines.find((l) => l.fullName === 'Bob')!;
    expect(amy.bonusCents).toBe(calculateDailyBonusCents(79, WOODLAND_RULE));
    expect(bob.bonusCents).toBe(calculateDailyBonusCents(60, WOODLAND_RULE));
    // 79: (79-50)*50 + (79-74)*25 = 1450 + 125 = 1575; 60: (60-50)*50 = 500.
    expect(amy.bonusCents).toBe(1575);
    expect(bob.bonusCents).toBe(500);
  });
});

describe('buildDailyReport — total_bonus_cents is the sum of line bonuses', () => {
  it('sums every line bonus', async () => {
    todayRows = [
      {
        mattress_count: dec(79),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
      {
        mattress_count: dec(60),
        entered_at: new Date('2026-06-16T10:00:00Z'),
        bonus_employee: { id: 'emp-bob', full_name: 'Bob' },
      },
    ];
    const report = await build(REPORT_DATE);
    const expected = report.lines.reduce((n, l) => n + l.bonusCents, 0);
    expect(report.totalBonusCents).toBe(expected);
    expect(report.totalBonusCents).toBe(1575 + 500);
  });
});

describe('buildDailyReport — Eugene-style empty history', () => {
  it('renders null comparisons and null pace when no prior windows have data', async () => {
    todayRows = [
      {
        mattress_count: dec(60),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
    ];
    // Today's entry lives in the same table the MTD range query reads, so it
    // appears in the MTD window [Jun 1, Jun 16]. The PRIOR windows (same-day-last-
    // year, prior-month-same-period) are genuinely empty → null (Eugene's case).
    historyRows = [{ entry_date: REPORT_DATE, mattress_count: dec(60) }];
    const report = await build(REPORT_DATE);

    expect(report.sameDayLastYear.total).toBeNull();
    expect(report.priorMonthSamePeriod.total).toBeNull();
    expect(report.paceDeltaPct).toBeNull();
    // MTD reflects today (the only day with data this month).
    expect(report.mtd.total).toBe(report.totalToday);
  });
});

describe('buildDailyReport — MTD when today is the only day with data', () => {
  it('mtd.total equals totalToday', async () => {
    todayRows = [
      {
        mattress_count: dec(55),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
      {
        mattress_count: dec(40),
        entered_at: new Date('2026-06-16T10:00:00Z'),
        bonus_employee: { id: 'emp-bob', full_name: 'Bob' },
      },
    ];
    // The MTD range query (gte firstOfMonth, lte reportDate) returns today's rows
    // only — no earlier days this month.
    historyRows = [
      { entry_date: REPORT_DATE, mattress_count: dec(55) },
      { entry_date: REPORT_DATE, mattress_count: dec(40) },
    ];
    const report = await build(REPORT_DATE);

    expect(report.totalToday).toBe(95);
    expect(report.mtd.total).toBe(95);
    expect(report.mtd.total).toBe(report.totalToday);
  });
});

describe('buildDailyReport — paceDeltaPct rounding (positive)', () => {
  it('rounds the positive MTD-vs-prior delta to one decimal', async () => {
    // Today (and full MTD) = 100; prior-month same period = 90.
    // delta = (100/90 - 1) * 100 = 11.111…% → rounds to 11.1.
    todayRows = [
      {
        mattress_count: dec(100),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
    ];
    historyRows = [
      // MTD this month = 100 (today only).
      { entry_date: REPORT_DATE, mattress_count: dec(100) },
      // Prior-month same period (May 1 – May 16) = 90.
      { entry_date: new Date(Date.UTC(2026, 4, 10)), mattress_count: dec(90) },
    ];
    const report = await build(REPORT_DATE);

    expect(report.mtd.total).toBe(100);
    expect(report.priorMonthSamePeriod.total).toBe(90);
    expect(report.paceDeltaPct).toBe(11.1);
  });
});

describe('buildDailyReport — paceDeltaPct rounding (negative)', () => {
  it('rounds the negative MTD-vs-prior delta to one decimal', async () => {
    // MTD = 80; prior = 90 → (80/90 - 1)*100 = -11.111…% → -11.1.
    todayRows = [
      {
        mattress_count: dec(80),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
    ];
    historyRows = [
      { entry_date: REPORT_DATE, mattress_count: dec(80) },
      { entry_date: new Date(Date.UTC(2026, 4, 10)), mattress_count: dec(90) },
    ];
    const report = await build(REPORT_DATE);

    expect(report.mtd.total).toBe(80);
    expect(report.priorMonthSamePeriod.total).toBe(90);
    expect(report.paceDeltaPct).toBe(-11.1);
  });
});

// ── Rounding/basis consistency (Terry audit F1/F8) ──────────────────
// These lock the fix for the divergence that would have shown MTD < today, and
// the bonus-vs-signed-PDF basis mismatch, on fractional Decimal(5,1) counts.

describe('buildDailyReport — fractional counts: totalToday === MTD (no round/sum divergence)', () => {
  it('floors each entry consistently so a single-day month reconciles exactly', async () => {
    // 30.5 + 40.5: round-then-sum (old line path) = 31+41 = 72; sum-then-round
    // (old range path) = round(71) = 71 → would mismatch. Floor-everywhere = 30+40 = 70 both.
    todayRows = [
      {
        mattress_count: dec(30.5),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-a', full_name: 'A' },
      },
      {
        mattress_count: dec(40.5),
        entered_at: new Date('2026-06-16T10:00:00Z'),
        bonus_employee: { id: 'emp-b', full_name: 'B' },
      },
    ];
    historyRows = [
      { entry_date: REPORT_DATE, mattress_count: dec(30.5) },
      { entry_date: REPORT_DATE, mattress_count: dec(40.5) },
    ];
    const report = await build(REPORT_DATE);
    expect(report.totalToday).toBe(70);
    expect(report.mtd.total).toBe(70);
    expect(report.mtd.total).toBe(report.totalToday);
    // Displayed per-line units are the floored integers, summing to the total.
    expect(report.lines.map((l) => l.mattresses)).toEqual([40, 30]);
  });
});

describe('buildDailyReport — fractional counts: bonus basis matches the signed PDF (floor)', () => {
  it('computes per-line bonus on the SAME floored basis as month-list/PDF', async () => {
    const { calculateDailyBonusCents } = await import('../calculator');
    // 50.5 is a tier boundary: floor→50 = $0.00 (in-threshold); round→51 = $0.50.
    // The signed-PDF path passes raw .toNumber() (calculator floors), so the
    // report MUST match calculateDailyBonusCents(50.5) === floor(50.5)=50 → 0.
    todayRows = [
      {
        mattress_count: dec(50.5),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-a', full_name: 'A' },
      },
    ];
    const report = await build(REPORT_DATE);
    const line = report.lines[0]!;
    expect(line.mattresses).toBe(50);
    expect(line.bonusCents).toBe(calculateDailyBonusCents(50.5, WOODLAND_RULE));
    expect(line.bonusCents).toBe(0);
  });
});

describe('buildDailyReport — MTD excludes the prior month (left boundary)', () => {
  it('does not leak a May 31 entry into a June MTD window', async () => {
    todayRows = [
      {
        mattress_count: dec(40),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-a', full_name: 'A' },
      },
    ];
    historyRows = [
      { entry_date: new Date(Date.UTC(2026, 4, 31)), mattress_count: dec(99) }, // May 31 — must be excluded
      { entry_date: REPORT_DATE, mattress_count: dec(40) },
    ];
    const report = await build(REPORT_DATE);
    expect(report.totalToday).toBe(40);
    expect(report.mtd.total).toBe(40); // 99 from May 31 not counted
  });
});

describe('buildDailyReport — paceDeltaPct is -100.0 for a zero MTD against a non-zero prior', () => {
  it('treats a real zero-production MTD as -100% (not null/NaN)', async () => {
    todayRows = [
      {
        mattress_count: dec(0),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-a', full_name: 'A' },
      },
    ];
    historyRows = [
      { entry_date: REPORT_DATE, mattress_count: dec(0) },
      { entry_date: new Date(Date.UTC(2026, 4, 10)), mattress_count: dec(90) },
    ];
    const report = await build(REPORT_DATE);
    expect(report.mtd.total).toBe(0);
    expect(report.priorMonthSamePeriod.total).toBe(90);
    expect(report.paceDeltaPct).toBe(-100);
  });
});

// ── ADR-0032: reporting-only production adjustments ──────────────────
//
// Adjustments are signed unit deltas keyed by day, summed by sumRangeOrNull into
// every PRODUCTION-QUANTITY total (MTD, prior-month, same-day-last-year), but they
// NEVER touch any BONUS-DOLLAR total (per-line bonusCents / totalBonusCents),
// because those come from bonus_daily_entries alone. This is the invariant that
// keeps the frozen closed-period payout untouched.

describe('buildDailyReport — ADR-0032 reporting adjustments', () => {
  it('MTD includes positive AND negative adjustments alongside real entries', async () => {
    todayRows = [
      {
        mattress_count: dec(100),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-a', full_name: 'A' },
      },
    ];
    historyRows = [
      { entry_date: new Date(Date.UTC(2026, 5, 1)), mattress_count: dec(944) },
      { entry_date: new Date(Date.UTC(2026, 5, 2)), mattress_count: dec(682) },
      { entry_date: REPORT_DATE, mattress_count: dec(100) },
    ];
    // Mirrors the operator's five June corrections (subset that lands in [Jun 1..16]):
    // 6/1 -4, 6/2 +13, 6/4 +694, 6/5 +653, 6/8 +451 = +1807 net.
    adjustmentRows = [
      { entry_date: new Date(Date.UTC(2026, 5, 1)), units: -4 },
      { entry_date: new Date(Date.UTC(2026, 5, 2)), units: 13 },
      { entry_date: new Date(Date.UTC(2026, 5, 4)), units: 694 },
      { entry_date: new Date(Date.UTC(2026, 5, 5)), units: 653 },
      { entry_date: new Date(Date.UTC(2026, 5, 8)), units: 451 },
    ];
    const report = await build(REPORT_DATE);
    // base entries 944 + 682 + 100 = 1726, plus net adjustments 1807 = 3533.
    expect(report.mtd.total).toBe(1726 + 1807);
  });

  it('a same-day-last-year window with ONLY an adjustment is non-null (not "no data")', async () => {
    todayRows = [
      {
        mattress_count: dec(50),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-a', full_name: 'A' },
      },
    ];
    historyRows = []; // no real entries anywhere
    // Adjustment on the same-day-last-year date (2025-06-16) — the prior-year
    // comparison must surface +12 rather than null.
    adjustmentRows = [{ entry_date: new Date(Date.UTC(2025, 5, 16)), units: 12 }];
    const report = await build(REPORT_DATE);
    expect(report.sameDayLastYear.total).toBe(12);
  });

  it('adjustments do NOT change any bonus-dollar total (frozen-payout invariant)', async () => {
    const { calculateDailyBonusCents } = await import('../calculator');
    todayRows = [
      {
        mattress_count: dec(79),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-a', full_name: 'A' },
      },
    ];
    historyRows = [{ entry_date: REPORT_DATE, mattress_count: dec(79) }];

    // Build once with NO adjustments, once with a large adjustment in-window.
    const before = await build(REPORT_DATE);
    adjustmentRows = [{ entry_date: REPORT_DATE, units: 5000 }];
    const after = await build(REPORT_DATE);

    const expectedBonus = calculateDailyBonusCents(79, WOODLAND_RULE);
    // Per-line + total bonus cents are identical regardless of the adjustment.
    expect(before.totalBonusCents).toBe(expectedBonus);
    expect(after.totalBonusCents).toBe(expectedBonus);
    expect(after.lines[0]?.bonusCents).toBe(before.lines[0]?.bonusCents);
    expect(after.lines[0]?.bonusCents).toBe(expectedBonus);
    // totalToday (today's per-employee unit sum) is also adjustment-free — only
    // the range comparisons (MTD etc.) pick up adjustments.
    expect(after.totalToday).toBe(before.totalToday);
    // But the MTD production total DID move by exactly the adjustment.
    expect((after.mtd.total ?? 0) - (before.mtd.total ?? 0)).toBe(5000);
  });
});

// Lock-in cases from the 2026-07-06 "June not July" report (investigated: the
// math was CORRECT — the June was either the Jun-30 report's correct SDLY or
// the same-period-last-month line. These pin the behavior permanently.)
describe('2026-07-06 investigation lock-ins', () => {
  it('Jul 3 2026 SDLY is Jul 3 2025 (July, never June)', () => {
    const d = sameDayPriorYear(new Date(Date.UTC(2026, 6, 3)));
    expect([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]).toEqual([2025, 7, 3]);
  });
  it('Jun 30 2026 SDLY is Jun 30 2025 (a June SDLY on a June report is correct)', () => {
    const d = sameDayPriorYear(new Date(Date.UTC(2026, 5, 30)));
    expect([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]).toEqual([2025, 6, 30]);
  });
  it('Jul 31 same-period-last-month clamps to Jun 30 (overflow-safe)', () => {
    const d = sameDomPriorMonth(new Date(Date.UTC(2026, 6, 31)));
    expect([d.getUTCMonth() + 1, d.getUTCDate()]).toEqual([6, 30]);
  });
});

// ── ADR-0037 Phase 4 — EOD inventory wire-up ────────────────────────

describe('buildDailyReport EOD inventory wiring', () => {
  it('attaches the EOD inventory snapshot to the report', async () => {
    eodSnapshot = { state: 'healthy', totalOnHand: 3977 };
    const report = await build(new Date(Date.UTC(2026, 6, 22)));
    expect(report.eodInventory).toEqual({ state: 'healthy', totalOnHand: 3977 });
  });

  it('still produces the production report when the inventory read fails', async () => {
    eodThrows = true;
    todayRows = [
      {
        mattress_count: dec(60),
        entered_at: new Date(Date.UTC(2026, 6, 22, 1)),
        bonus_employee: { id: 'e1', full_name: 'Jeremy' },
      },
    ];
    const report = await build(new Date(Date.UTC(2026, 6, 22)));
    expect(report.totalToday).toBe(60);
    expect(report.eodInventory).toBeUndefined();
  });
});

// ── ADR-0076 — processor headcounts ─────────────────────────────────

describe('buildDailyReport — processor headcounts (ADR-0076)', () => {
  it('today equals lines.length on a multi-line day (no query — the unique constraint)', async () => {
    todayRows = [
      {
        mattress_count: dec(60),
        entered_at: new Date('2026-06-16T10:00:00Z'),
        bonus_employee: { id: 'emp-bob', full_name: 'Bob' },
      },
      {
        mattress_count: dec(79),
        entered_at: new Date('2026-06-16T09:00:00Z'),
        bonus_employee: { id: 'emp-amy', full_name: 'Amy' },
      },
    ];
    const report = await build(REPORT_DATE);
    expect(report.processorCounts.today).toBe(2);
  });

  it('an employee who worked three separate days in the month counts ONCE in mtd', async () => {
    historyRows = [
      {
        entry_date: new Date(Date.UTC(2026, 5, 2)),
        mattress_count: dec(50),
        bonus_employee_id: 'emp-amy',
      },
      {
        entry_date: new Date(Date.UTC(2026, 5, 9)),
        mattress_count: dec(55),
        bonus_employee_id: 'emp-amy',
      },
      {
        entry_date: new Date(Date.UTC(2026, 5, 15)),
        mattress_count: dec(60),
        bonus_employee_id: 'emp-amy',
      },
      {
        entry_date: new Date(Date.UTC(2026, 5, 10)),
        mattress_count: dec(40),
        bonus_employee_id: 'emp-bob',
      },
    ];
    const report = await build(REPORT_DATE);
    expect(report.processorCounts.mtd).toBe(2); // Amy once + Bob once — never 4
  });

  it('windows are scoped: prior-month and SDLY rows never leak into mtd', async () => {
    historyRows = [
      {
        entry_date: new Date(Date.UTC(2026, 5, 3)),
        mattress_count: dec(50),
        bonus_employee_id: 'emp-amy',
      },
      {
        entry_date: new Date(Date.UTC(2026, 4, 5)),
        mattress_count: dec(50),
        bonus_employee_id: 'emp-may1',
      },
      {
        entry_date: new Date(Date.UTC(2026, 4, 9)),
        mattress_count: dec(50),
        bonus_employee_id: 'emp-may2',
      },
      {
        entry_date: new Date(Date.UTC(2025, 5, 16)),
        mattress_count: dec(50),
        bonus_employee_id: 'emp-old',
      },
    ];
    const report = await build(REPORT_DATE);
    expect(report.processorCounts.mtd).toBe(1);
    expect(report.processorCounts.priorMonthSamePeriod).toBe(2);
    expect(report.processorCounts.sameDayLastYear).toBe(1);
  });

  it('an empty day and empty history yield zeros (0, never null — a count of nobody is 0)', async () => {
    const report = await build(REPORT_DATE);
    expect(report.processorCounts).toEqual({
      today: 0,
      mtd: 0,
      priorMonthSamePeriod: 0,
      sameDayLastYear: 0,
    });
  });

  it('a day whose only entry is a zero count still counts the processor (today=1, totalToday=0)', async () => {
    todayRows = [
      {
        mattress_count: dec(0),
        entered_at: new Date('2026-06-16T10:00:00Z'),
        bonus_employee: { id: 'emp-zero', full_name: 'Zed' },
      },
    ];
    const report = await build(REPORT_DATE);
    expect(report.processorCounts.today).toBe(1);
    expect(report.totalToday).toBe(0);
  });

  it('an ADR-0032 adjustment moves mtd units but NEVER the mtd headcount', async () => {
    historyRows = [
      {
        entry_date: new Date(Date.UTC(2026, 5, 3)),
        mattress_count: dec(100),
        bonus_employee_id: 'emp-amy',
      },
    ];
    adjustmentRows = [{ entry_date: new Date(Date.UTC(2026, 5, 4)), units: 500 }];
    const report = await build(REPORT_DATE);
    expect(report.mtd.total).toBe(600); // units include the adjustment
    expect(report.processorCounts.mtd).toBe(1); // headcount cannot see it
  });
});
