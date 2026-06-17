// ADR-0019 §8 — Aggregate views data-layer tests (T-118).
//
// DB-free: mocks `@/lib/prisma` with in-memory Maps and drives the REAL
// `aggregates.ts`. Covers the acceptance criteria:
//   - employeeHistory monthly rollup math == calculator, per-month rule
//   - YTD sums (current UTC calendar year only)
//   - last-12-months series ordered oldest → newest
//   - rename display: CURRENT name + previousNames surfaced (ADR-0019 §9b)
//   - site scoping: a non-Woodland employee resolves to null
//   - annualTotals sums correctly and is sorted by current name
//   - csvForAnnual has the right columns + previously-known-as + dollar string

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';

// T-330: mattress_count is Decimal(5,1) — Prisma returns a Decimal on read, so
// the mock store holds Decimals and the aggregates layer's `.toNumber()` works.
type Dec = Prisma.Decimal;
const toDec = (n: number): Dec => new Prisma.Decimal(n);

// ── In-memory stores ────────────────────────────────────────────
interface MockMonth {
  id: string;
  site_id: string;
  period_number: number;
  period_start: Date;
  period_end: Date;
  state: string;
}
interface MockEmployee {
  id: string;
  site_id: string;
  full_name: string;
  previous_names: unknown;
  is_active: boolean;
}
interface MockEntry {
  id: string;
  bonus_employee_id: string;
  bonus_pay_period_id: string;
  entry_date: Date;
  mattress_count: Dec;
}
interface MockRule {
  id: string;
  site_id: string;
  threshold_low: number;
  rate_low: { toString(): string };
  threshold_high: number;
  rate_high: { toString(): string };
  effective_date: Date;
  end_date: Date | null;
}

const monthStore = new Map<string, MockMonth>();
const empStore = new Map<string, MockEmployee>();
const entryStore = new Map<string, MockEntry>();
const ruleStore = new Map<string, MockRule>();
let idCounter = 0;

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';
const THIS_YEAR = new Date().getUTCFullYear();

// Woodland rule (ADR-0019 §1): threshold_low=50 @ $0.50, threshold_high=74 @ $0.25.
const WOODLAND_RULE = {
  threshold_low: 50,
  rate_low: '0.5000',
  threshold_high: 74,
  rate_high: '0.2500',
};

function um(year: number, monthIndex0: number): Date {
  return new Date(Date.UTC(year, monthIndex0, 1));
}

function addMonth(
  year: number,
  monthIndex0: number,
  state = 'paid',
  opts: { day?: number; period_number?: number; period_end?: Date } = {},
): MockMonth {
  const startDay = opts.day ?? 1;
  const period_start = new Date(Date.UTC(year, monthIndex0, startDay));
  const period_end = opts.period_end ?? new Date(Date.UTC(year, monthIndex0, startDay + 13));
  const m: MockMonth = {
    id: `month-${++idCounter}`,
    site_id: WOODLAND,
    period_number: opts.period_number ?? idCounter,
    period_start,
    period_end,
    state,
  };
  monthStore.set(m.id, m);
  return m;
}

function addEmp(
  id: string,
  full_name: string,
  opts: { site_id?: string; previous_names?: unknown; is_active?: boolean } = {},
): MockEmployee {
  const e: MockEmployee = {
    id,
    site_id: opts.site_id ?? WOODLAND,
    full_name,
    previous_names: opts.previous_names ?? null,
    is_active: opts.is_active ?? true,
  };
  empStore.set(id, e);
  return e;
}

function addEntry(monthId: string, empId: string, day: number, count: number): void {
  const m = monthStore.get(monthId)!;
  const date = new Date(
    Date.UTC(m.period_start.getUTCFullYear(), m.period_start.getUTCMonth(), day),
  );
  const e: MockEntry = {
    id: `entry-${++idCounter}`,
    bonus_employee_id: empId,
    bonus_pay_period_id: monthId,
    entry_date: date,
    mattress_count: toDec(count),
  };
  entryStore.set(e.id, e);
}

function reset(): void {
  monthStore.clear();
  empStore.clear();
  entryStore.clear();
  ruleStore.clear();
  idCounter = 0;
  ruleStore.set('rule-wo', {
    id: 'rule-wo',
    site_id: WOODLAND,
    threshold_low: WOODLAND_RULE.threshold_low,
    rate_low: { toString: () => WOODLAND_RULE.rate_low },
    threshold_high: WOODLAND_RULE.threshold_high,
    rate_high: { toString: () => WOODLAND_RULE.rate_high },
    effective_date: um(2000, 0),
    end_date: null,
  });
}

// ── Mock matchers ────────────────────────────────────────────────
function inList(where: Record<string, unknown>, key: string, value: string): boolean {
  if (!(key in where)) return true;
  const w = where[key] as unknown;
  if (typeof w === 'string') return value === w;
  if (w && typeof w === 'object' && 'in' in (w as Record<string, unknown>)) {
    return (w as { in: string[] }).in.includes(value);
  }
  return true;
}

vi.mock('@/lib/prisma', () => {
  const bonusPayPeriod = {
    findMany: vi.fn(
      async ({
        where = {},
        orderBy,
      }: {
        where?: Record<string, unknown>;
        orderBy?: { period_start?: 'asc' | 'desc' };
      } = {}) => {
        let out = [...monthStore.values()].filter((m) => {
          if ('site_id' in where && m.site_id !== where['site_id']) return false;
          if ('period_start' in where) {
            const range = where['period_start'] as { gte?: Date; lt?: Date };
            if (range.gte && m.period_start.getTime() < range.gte.getTime()) return false;
            if (range.lt && m.period_start.getTime() >= range.lt.getTime()) return false;
          }
          return true;
        });
        if (orderBy?.period_start === 'desc') {
          out = out.sort((a, b) => b.period_start.getTime() - a.period_start.getTime());
        }
        return out.map((m) => ({ ...m }));
      },
    ),
  };

  const bonusEmployee = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const e of empStore.values()) {
        if ('id' in where && e.id !== where['id']) continue;
        if ('site_id' in where && e.site_id !== where['site_id']) continue;
        return { ...e };
      }
      return null;
    }),
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      return [...empStore.values()]
        .filter((e) => inList(where, 'id', e.id))
        .filter((e) => !('site_id' in where) || e.site_id === where['site_id'])
        .map((e) => ({ ...e }));
    }),
  };

  const bonusDailyEntry = {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      return [...entryStore.values()]
        .filter((e) => {
          if ('bonus_employee_id' in where && e.bonus_employee_id !== where['bonus_employee_id'])
            return false;
          if (!inList(where, 'bonus_pay_period_id', e.bonus_pay_period_id)) return false;
          // bonus_pay_period: { site_id } relation filter
          if ('bonus_pay_period' in where) {
            const rel = where['bonus_pay_period'] as { site_id?: string };
            const m = monthStore.get(e.bonus_pay_period_id);
            if (rel.site_id && (!m || m.site_id !== rel.site_id)) return false;
          }
          return true;
        })
        .map((e) => ({ ...e }));
    }),
  };

  const processorBonusRule = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const r of ruleStore.values()) {
        if (r.site_id !== where['site_id']) continue;
        return { ...r };
      }
      return null;
    }),
  };

  return { prisma: { bonusPayPeriod, bonusEmployee, bonusDailyEntry, processorBonusRule } };
});

// Import AFTER the mock is registered.
import {
  employeeHistory,
  annualTotals,
  csvForAnnual,
  type AnnualEmployeeRow,
} from '@/lib/bonus/aggregates';

beforeEach(() => {
  reset();
});

// expected bonus for one day with the Woodland rule.
function dayBonus(count: number): number {
  return calculateDailyBonusCents(count, WOODLAND_RULE);
}

describe('employeeHistory', () => {
  it('labels each period canonically and distinctly within one calendar month (ADR-0031)', async () => {
    // The pre-cadence bug: two bi-weekly periods both START in June 2026, so the
    // old calendar-month label rendered "June 2026" for BOTH rows.
    const p13 = addMonth(2026, 5, 'paid', { day: 9, period_number: 13 }); // Jun 9–22
    const p14 = addMonth(2026, 5, 'paid', {
      day: 23,
      period_number: 14,
      period_end: new Date(Date.UTC(2026, 6, 6)), // Jul 6 (spans the month)
    });
    addEntry(p13.id, 'emp-amy', 10, 60);
    addEntry(p14.id, 'emp-amy', 24, 60);
    addEmp('emp-amy', 'Amy');

    const h = (await employeeHistory(WOODLAND, 'emp-amy'))!;
    const labels = h.months.map((m) => m.label);
    expect(labels).toContain('Period 13 · Jun 9–22, 2026');
    expect(labels).toContain('Period 14 · Jun 23, 2026 – Jul 6, 2026');
    // Distinct — the defect was both rows reading "June 2026".
    expect(new Set(labels).size).toBe(labels.length);

    const short = h.months.map((m) => m.shortLabel);
    expect(short).toContain('Period 13');
    expect(short).toContain('Period 14');
  });

  it('rolls up monthly totals == calculator and surfaces YTD', async () => {
    const may = addMonth(THIS_YEAR, 4); // May
    const jun = addMonth(THIS_YEAR, 5); // June
    addEntry(may.id, 'emp-amy', 1, 60); // bonus for 60
    addEntry(may.id, 'emp-amy', 2, 80); // bonus for 80
    addEntry(jun.id, 'emp-amy', 1, 100);
    addEmp('emp-amy', 'Amy');

    const hist = await employeeHistory(WOODLAND, 'emp-amy');
    expect(hist).not.toBeNull();
    const h = hist!;

    // Newest first.
    expect(h.months.map((m) => m.ym)).toEqual([`${THIS_YEAR}-06`, `${THIS_YEAR}-05`]);

    const mayRow = h.months.find((m) => m.ym === `${THIS_YEAR}-05`)!;
    expect(mayRow.mattresses).toBe(140);
    expect(mayRow.daysQualified).toBe(2);
    expect(mayRow.bonusCents).toBe(dayBonus(60) + dayBonus(80));

    const junRow = h.months.find((m) => m.ym === `${THIS_YEAR}-06`)!;
    expect(junRow.bonusCents).toBe(dayBonus(100));

    // YTD == sum of both months.
    expect(h.ytd.mattresses).toBe(240);
    expect(h.ytd.daysQualified).toBe(3);
    expect(h.ytd.bonusCents).toBe(dayBonus(60) + dayBonus(80) + dayBonus(100));
  });

  it('excludes prior-year months from YTD but keeps them in the month list', async () => {
    const dec = addMonth(THIS_YEAR - 1, 11); // last December
    const jan = addMonth(THIS_YEAR, 0); // this January
    addEntry(dec.id, 'emp-bob', 1, 90);
    addEntry(jan.id, 'emp-bob', 1, 70);
    addEmp('emp-bob', 'Bob');

    const h = (await employeeHistory(WOODLAND, 'emp-bob'))!;
    expect(h.months).toHaveLength(2);
    // YTD only this year's January.
    expect(h.ytd.bonusCents).toBe(dayBonus(70));
    expect(h.ytd.mattresses).toBe(70);
  });

  it('returns last12 oldest → newest', async () => {
    // 14 months back from this month; only newest 12 in last12, oldest first.
    const made: string[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.UTC(THIS_YEAR, new Date().getUTCMonth() - i, 1));
      const m = addMonth(d.getUTCFullYear(), d.getUTCMonth());
      addEntry(m.id, 'emp-cara', 1, 55);
      made.push(m.id);
    }
    addEmp('emp-cara', 'Cara');

    const h = (await employeeHistory(WOODLAND, 'emp-cara'))!;
    expect(h.last12).toHaveLength(12);
    // ascending by period_start.
    for (let i = 1; i < h.last12.length; i++) {
      expect(h.last12[i]!.monthStart.getTime()).toBeGreaterThan(
        h.last12[i - 1]!.monthStart.getTime(),
      );
    }
    // newest of last12 == newest overall.
    expect(h.last12.at(-1)!.ym).toBe(h.months[0]!.ym);
  });

  it('displays the current name and surfaces previous_names (ADR-0019 §9b)', async () => {
    const may = addMonth(THIS_YEAR, 4);
    addEntry(may.id, 'emp-dee', 1, 60);
    addEmp('emp-dee', 'Dana Smith', {
      previous_names: [{ name: 'Dana Jones', changed_at: '2026-03-01T00:00:00.000Z' }],
    });

    const h = (await employeeHistory(WOODLAND, 'emp-dee'))!;
    expect(h.name).toBe('Dana Smith');
    expect(h.previousNames).toEqual([
      { name: 'Dana Jones', changed_at: '2026-03-01T00:00:00.000Z' },
    ]);
  });

  it('empty previous_names when none', async () => {
    const may = addMonth(THIS_YEAR, 4);
    addEntry(may.id, 'emp-e', 1, 60);
    addEmp('emp-e', 'Ed');
    const h = (await employeeHistory(WOODLAND, 'emp-e'))!;
    expect(h.previousNames).toEqual([]);
  });

  it('is site-scoped: a non-Woodland employee resolves to null', async () => {
    addEmp('emp-eugene', 'Eve', { site_id: EUGENE });
    const h = await employeeHistory(WOODLAND, 'emp-eugene');
    expect(h).toBeNull();
  });

  it('omits months where the employee keyed nothing', async () => {
    const may = addMonth(THIS_YEAR, 4);
    addMonth(THIS_YEAR, 5); // June: no entries for this employee
    addEntry(may.id, 'emp-f', 1, 60);
    addEmp('emp-f', 'Fran');
    const h = (await employeeHistory(WOODLAND, 'emp-f'))!;
    expect(h.months.map((m) => m.ym)).toEqual([`${THIS_YEAR}-05`]);
  });
});

describe('annualTotals', () => {
  it('sums per-employee YTD across the year and sorts by current name', async () => {
    const may = addMonth(THIS_YEAR, 4);
    const jun = addMonth(THIS_YEAR, 5);
    const lastYear = addMonth(THIS_YEAR - 1, 5); // must be excluded
    addEmp('emp-zane', 'Zane');
    addEmp('emp-amy', 'Amy');
    addEntry(may.id, 'emp-zane', 1, 60);
    addEntry(jun.id, 'emp-zane', 1, 80);
    addEntry(may.id, 'emp-amy', 1, 100);
    addEntry(lastYear.id, 'emp-amy', 1, 999); // prior year, ignored

    const rows = await annualTotals(WOODLAND, THIS_YEAR);
    expect(rows.map((r) => r.name)).toEqual(['Amy', 'Zane']); // sorted

    const zane = rows.find((r) => r.name === 'Zane')!;
    expect(zane.mattresses).toBe(140);
    expect(zane.daysQualified).toBe(2);
    expect(zane.bonusCents).toBe(dayBonus(60) + dayBonus(80));

    const amy = rows.find((r) => r.name === 'Amy')!;
    expect(amy.bonusCents).toBe(dayBonus(100)); // prior-year row excluded
  });

  it('returns [] for a year with no months', async () => {
    addMonth(THIS_YEAR, 4);
    const rows = await annualTotals(WOODLAND, THIS_YEAR - 5);
    expect(rows).toEqual([]);
  });

  it('includes deactivated employees who keyed entries in the year', async () => {
    const may = addMonth(THIS_YEAR, 4);
    addEmp('emp-gone', 'Gus', { is_active: false });
    addEntry(may.id, 'emp-gone', 1, 80);
    const rows = await annualTotals(WOODLAND, THIS_YEAR);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isActive).toBe(false);
    expect(rows[0]!.bonusCents).toBe(dayBonus(80));
  });
});

describe('csvForAnnual', () => {
  it('emits the expected header columns and a dollar string', () => {
    const rows: AnnualEmployeeRow[] = [
      {
        employeeId: 'a',
        name: 'Amy',
        previousNames: [{ name: 'Amy Jones', changed_at: '2026-01-01T00:00:00.000Z' }],
        isActive: true,
        mattresses: 140,
        daysQualified: 2,
        bonusCents: 1275,
      },
    ];
    const csv = csvForAnnual(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'employee,previously_known_as,active,total_mattresses,days_qualified,total_bonus_usd',
    );
    expect(lines[1]).toBe('Amy,Amy Jones,yes,140,2,12.75');
  });

  it('joins multiple previous names with a semicolon and blanks when none', () => {
    const rows: AnnualEmployeeRow[] = [
      {
        employeeId: 'b',
        name: 'Bob',
        previousNames: [
          { name: 'Bob One', changed_at: 'x' },
          { name: 'Bob Two', changed_at: 'y' },
        ],
        isActive: false,
        mattresses: 0,
        daysQualified: 0,
        bonusCents: 0,
      },
      {
        employeeId: 'c',
        name: 'Cara',
        previousNames: [],
        isActive: true,
        mattresses: 10,
        daysQualified: 0,
        bonusCents: 0,
      },
    ];
    const csv = csvForAnnual(rows);
    const lines = csv.split('\n');
    // semicolon-joined list is quoted by papaparse because it contains a comma? no — semicolons aren't special.
    expect(lines[1]).toBe('Bob,Bob One; Bob Two,no,0,0,0.00');
    expect(lines[2]).toBe('Cara,,yes,10,0,0.00');
  });

  it('produces only a header row for empty input', () => {
    const csv = csvForAnnual([]);
    // papaparse emits the header followed by a trailing newline when data is empty.
    expect(csv.split('\n')[0]).toBe(
      'employee,previously_known_as,active,total_mattresses,days_qualified,total_bonus_usd',
    );
    expect(csv.trim()).toBe(
      'employee,previously_known_as,active,total_mattresses,days_qualified,total_bonus_usd',
    );
  });
});
