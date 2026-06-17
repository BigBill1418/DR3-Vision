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
}

let siteRow: { id: string; code: string; name: string } | null;
let todayRows: TodayRow[];
let historyRows: HistoryRow[];

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
    },
  },
}));

beforeEach(() => {
  siteRow = { id: WOODLAND, code: 'woodland', name: 'Woodland' };
  todayRows = [];
  historyRows = [];
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
