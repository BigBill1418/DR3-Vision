// ADR-0031 — Current pay-period standings data-layer tests.
//
// DB-free: mocks `@/lib/prisma` with in-memory Maps and drives the REAL
// `current-period.ts` (and the real `listEmployees` / `resolveOpenPayPeriod` /
// `resolveActiveRule` it composes). Covers:
//   - per-employee tally == calculator, qualified vs short-day classification
//   - units / bonus / days sums for the OPEN period only
//   - active roster with zero entries appears at 0/0/0/$0
//   - inactive processors are excluded from the standings table…
//   - …but currentPeriodForEmployee still reports an inactive processor's
//     open-period entries (focused query, not the active roster)
//   - no open period → period null, thresholdLow null, roster at zero
//   - period label + thresholdLow surfaced from the rule

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';

type Dec = Prisma.Decimal;
const toDec = (n: number): Dec => new Prisma.Decimal(n);

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

const WOODLAND_RULE = {
  threshold_low: 50,
  rate_low: '0.5000',
  threshold_high: 74,
  rate_high: '0.2500',
};
const dayBonus = (count: number): number => calculateDailyBonusCents(count, WOODLAND_RULE);

const UTC = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d));

interface MockPeriod {
  id: string;
  site_id: string;
  period_number: number;
  period_year: number;
  period_start: Date;
  period_end: Date;
  pay_date: Date;
  state: string;
}
interface MockEmployee {
  id: string;
  site_id: string;
  full_name: string;
  employee_number: string | null;
  previous_names: unknown;
  is_active: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
interface MockEntry {
  id: string;
  bonus_employee_id: string;
  bonus_pay_period_id: string;
  mattress_count: Dec;
}

const periodStore = new Map<string, MockPeriod>();
const empStore = new Map<string, MockEmployee>();
const entryStore = new Map<string, MockEntry>();
let idc = 0;

function addPeriod(opts: Partial<MockPeriod> = {}): MockPeriod {
  const p: MockPeriod = {
    id: opts.id ?? `period-${++idc}`,
    site_id: opts.site_id ?? WOODLAND,
    period_number: opts.period_number ?? 13,
    period_year: opts.period_year ?? 2026,
    period_start: opts.period_start ?? UTC(2026, 5, 9), // Tue Jun 9
    period_end: opts.period_end ?? UTC(2026, 5, 22), // Mon Jun 22
    pay_date: opts.pay_date ?? UTC(2026, 5, 26),
    state: opts.state ?? 'draft',
  };
  periodStore.set(p.id, p);
  return p;
}

function addEmp(
  id: string,
  full_name: string,
  opts: { site_id?: string; is_active?: boolean; employee_number?: string | null } = {},
): MockEmployee {
  const e: MockEmployee = {
    id,
    site_id: opts.site_id ?? WOODLAND,
    full_name,
    employee_number: opts.employee_number ?? null,
    previous_names: null,
    is_active: opts.is_active ?? true,
    notes: null,
    created_at: UTC(2026, 0, 1),
    updated_at: UTC(2026, 0, 1),
    deleted_at: null,
  };
  empStore.set(id, e);
  return e;
}

function addEntry(periodId: string, empId: string, count: number): void {
  const e: MockEntry = {
    id: `entry-${++idc}`,
    bonus_employee_id: empId,
    bonus_pay_period_id: periodId,
    mattress_count: toDec(count),
  };
  entryStore.set(e.id, e);
}

function reset(): void {
  periodStore.clear();
  empStore.clear();
  entryStore.clear();
  idc = 0;
}

vi.mock('@/lib/prisma', () => {
  const bonusPayPeriod = {
    findFirst: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      for (const p of periodStore.values()) {
        if ('site_id' in where && p.site_id !== where['site_id']) continue;
        const ps = where['period_start'] as { lte?: Date } | undefined;
        if (ps?.lte && p.period_start.getTime() > ps.lte.getTime()) continue;
        const pe = where['period_end'] as { gte?: Date } | undefined;
        if (pe?.gte && p.period_end.getTime() < pe.gte.getTime()) continue;
        return { ...p };
      }
      return null;
    }),
  };

  const bonusEmployee = {
    findMany: vi.fn(
      async ({
        where = {},
        orderBy,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
      } = {}) => {
        let out = [...empStore.values()].filter((e) => {
          if ('site_id' in where && e.site_id !== where['site_id']) return false;
          if ('is_active' in where && e.is_active !== where['is_active']) return false;
          return true;
        });
        // listEmployees name-sort path: [{ full_name: 'asc' }].
        out = out.sort((a, b) => a.full_name.localeCompare(b.full_name));
        void orderBy;
        return out.map((e) => ({ ...e }));
      },
    ),
  };

  const bonusDailyEntry = {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      return [...entryStore.values()]
        .filter((e) => {
          if (
            'bonus_pay_period_id' in where &&
            e.bonus_pay_period_id !== where['bonus_pay_period_id']
          )
            return false;
          if ('bonus_employee_id' in where && e.bonus_employee_id !== where['bonus_employee_id'])
            return false;
          return true;
        })
        .map((e) => ({ ...e }));
    }),
  };

  const processorBonusRule = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where['site_id'] !== WOODLAND) return null;
      return {
        id: 'rule-wo',
        site_id: WOODLAND,
        threshold_low: WOODLAND_RULE.threshold_low,
        rate_low: { toString: () => WOODLAND_RULE.rate_low },
        threshold_high: WOODLAND_RULE.threshold_high,
        rate_high: { toString: () => WOODLAND_RULE.rate_high },
        effective_date: UTC(2000, 0, 1),
        end_date: null,
      };
    }),
  };

  return { prisma: { bonusPayPeriod, bonusEmployee, bonusDailyEntry, processorBonusRule } };
});

// Import AFTER the mock is registered.
import { currentPeriodStandings, currentPeriodForEmployee } from '@/lib/bonus/current-period';

const INSIDE = UTC(2026, 5, 15); // within Period 13
const OUTSIDE = UTC(2026, 0, 1); // covered by no period

beforeEach(() => {
  reset();
});

describe('currentPeriodStandings', () => {
  it('tallies units, qualified/short days, and bonus per active processor', async () => {
    const p = addPeriod();
    addEmp('amy', 'Amy');
    addEmp('bob', 'Bob');
    addEmp('cara', 'Cara'); // active, no entries
    addEmp('dave', 'Dave', { is_active: false }); // excluded from the table
    addEntry(p.id, 'amy', 60); // qualified
    addEntry(p.id, 'amy', 50); // short (== threshold, $0)
    addEntry(p.id, 'amy', 80); // qualified (two-tier)
    addEntry(p.id, 'bob', 40); // short
    addEntry(p.id, 'dave', 100); // inactive — not on the table

    const { period, thresholdLow, rows } = await currentPeriodStandings(WOODLAND, INSIDE);

    expect(period?.label).toBe('Period 13 · Jun 9–22, 2026');
    expect(period?.state).toBe('draft');
    expect(thresholdLow).toBe(50);

    // Active roster only, name-sorted; Dave (inactive) absent.
    expect(rows.map((r) => r.name)).toEqual(['Amy', 'Bob', 'Cara']);

    const amy = rows.find((r) => r.name === 'Amy')!;
    expect(amy.units).toBe(190);
    expect(amy.daysQualified).toBe(2);
    expect(amy.daysShort).toBe(1);
    expect(amy.bonusCents).toBe(dayBonus(60) + dayBonus(50) + dayBonus(80));

    const bob = rows.find((r) => r.name === 'Bob')!;
    expect(bob.units).toBe(40);
    expect(bob.daysQualified).toBe(0);
    expect(bob.daysShort).toBe(1);
    expect(bob.bonusCents).toBe(0);

    const cara = rows.find((r) => r.name === 'Cara')!;
    expect(cara).toMatchObject({ units: 0, daysQualified: 0, daysShort: 0, bonusCents: 0 });
  });

  it('only counts entries from the OPEN period, not other periods', async () => {
    const open = addPeriod({ id: 'open', period_number: 13 });
    const closed = addPeriod({
      id: 'closed',
      period_number: 12,
      period_start: UTC(2026, 4, 26),
      period_end: UTC(2026, 5, 8),
      state: 'paid',
    });
    addEmp('amy', 'Amy');
    addEntry(open.id, 'amy', 60);
    addEntry(closed.id, 'amy', 200); // different period — must be ignored

    const { rows } = await currentPeriodStandings(WOODLAND, INSIDE);
    expect(rows[0]!.units).toBe(60);
    expect(rows[0]!.bonusCents).toBe(dayBonus(60));
  });

  it('returns the active roster at zero when no open period covers today', async () => {
    addPeriod();
    addEmp('amy', 'Amy');
    addEmp('bob', 'Bob');
    addEntry('period-1', 'amy', 60);

    const { period, thresholdLow, rows } = await currentPeriodStandings(WOODLAND, OUTSIDE);
    expect(period).toBeNull();
    expect(thresholdLow).toBeNull();
    expect(rows.map((r) => r.name)).toEqual(['Amy', 'Bob']);
    expect(rows.every((r) => r.units === 0 && r.bonusCents === 0)).toBe(true);
  });

  it('is site-scoped: a Eugene period does not open for Woodland', async () => {
    addPeriod({ site_id: EUGENE });
    addEmp('amy', 'Amy');
    const { period } = await currentPeriodStandings(WOODLAND, INSIDE);
    expect(period).toBeNull();
  });
});

describe('currentPeriodForEmployee', () => {
  it('reports one active processor’s open-period standing', async () => {
    const p = addPeriod();
    addEmp('amy', 'Amy');
    addEntry(p.id, 'amy', 60);
    addEntry(p.id, 'amy', 40); // short

    const { period, thresholdLow, standing } = await currentPeriodForEmployee(
      WOODLAND,
      'amy',
      INSIDE,
    );
    expect(period?.label).toBe('Period 13 · Jun 9–22, 2026');
    expect(thresholdLow).toBe(50);
    expect(standing).toEqual({
      units: 100,
      daysQualified: 1,
      daysShort: 1,
      bonusCents: dayBonus(60),
    });
  });

  it('reports a since-deactivated processor’s entries (focused query, not the roster)', async () => {
    const p = addPeriod();
    addEmp('dave', 'Dave', { is_active: false });
    addEntry(p.id, 'dave', 100);

    const { standing } = await currentPeriodForEmployee(WOODLAND, 'dave', INSIDE);
    expect(standing).not.toBeNull();
    expect(standing!.units).toBe(100);
    expect(standing!.bonusCents).toBe(dayBonus(100));
  });

  it('null standing when the processor has no keyed day this period', async () => {
    addPeriod();
    addEmp('cara', 'Cara');
    const { period, standing } = await currentPeriodForEmployee(WOODLAND, 'cara', INSIDE);
    expect(period).not.toBeNull(); // period is open…
    expect(standing).toBeNull(); // …but no activity yet
  });

  it('null period and standing when no open period covers today', async () => {
    addPeriod();
    addEmp('amy', 'Amy');
    addEntry('period-1', 'amy', 60);
    const res = await currentPeriodForEmployee(WOODLAND, 'amy', OUTSIDE);
    expect(res.period).toBeNull();
    expect(res.standing).toBeNull();
  });
});
