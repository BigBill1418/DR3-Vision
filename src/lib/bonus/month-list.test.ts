// ADR-0019 §8 — Historical bonus-month browsing data-layer tests (T-117).
//
// DB-free: mocks `@/lib/prisma` with in-memory Maps and drives the REAL
// `month-list.ts`. Covers the acceptance criteria + hard rules:
//   - filter windows: `current` (this UTC month), `year` (this UTC year), `all`
//   - ordering: newest-first
//   - payout: locked `total_payout_cents` preferred; else computed == calculator
//   - signature status derivation (none / partial / complete)
//   - amendment linkage (isAmendment + amendedFromMonthId)
//   - site scoping (hard rule #2): a non-Woodland month is never returned
//   - resilience: a pre-rule/empty month resolves to $0 rather than throwing
//   - pure helpers: parsePayPeriodFilter, payPeriodWindow

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';

// ── In-memory stores ────────────────────────────────────────────
interface MockMonth {
  id: string;
  site_id: string;
  period_start: Date;
  state: string;
  total_payout_cents: number | null;
  facility_signed_by_user_id: string | null;
  ops_signed_by_user_id: string | null;
  amended_from_period_id: string | null;
}
interface MockEntry {
  id: string;
  bonus_pay_period_id: string;
  mattress_count: number;
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
const entryStore = new Map<string, MockEntry>();
const ruleStore = new Map<string, MockRule>();
let idCounter = 0;

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

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

function addMonth(opts: {
  year: number;
  month0: number;
  state?: string;
  site_id?: string;
  total_payout_cents?: number | null;
  janette?: string | null;
  morena?: string | null;
  amended_from?: string | null;
}): MockMonth {
  const m: MockMonth = {
    id: `month-${++idCounter}`,
    site_id: opts.site_id ?? WOODLAND,
    period_start: um(opts.year, opts.month0),
    state: opts.state ?? 'paid',
    total_payout_cents: opts.total_payout_cents ?? null,
    facility_signed_by_user_id: opts.janette ?? null,
    ops_signed_by_user_id: opts.morena ?? null,
    amended_from_period_id: opts.amended_from ?? null,
  };
  monthStore.set(m.id, m);
  return m;
}

function addEntry(monthId: string, count: number): void {
  const e: MockEntry = {
    id: `entry-${++idCounter}`,
    bonus_pay_period_id: monthId,
    mattress_count: count,
  };
  entryStore.set(e.id, e);
}

function reset(): void {
  monthStore.clear();
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
        } else if (orderBy?.period_start === 'asc') {
          out = out.sort((a, b) => a.period_start.getTime() - b.period_start.getTime());
        }
        return out.map((m) => ({ ...m }));
      },
    ),
  };

  const bonusDailyEntry = {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      return [...entryStore.values()]
        .filter(
          (e) =>
            !('bonus_pay_period_id' in where) ||
            e.bonus_pay_period_id === where['bonus_pay_period_id'],
        )
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

  return { prisma: { bonusPayPeriod, bonusDailyEntry, processorBonusRule } };
});

// Import AFTER the mock is registered.
import {
  listBonusPayPeriods,
  parsePayPeriodFilter,
  payPeriodWindow,
  MONTH_FILTERS,
  type MonthFilter,
} from '@/lib/bonus/month-list';

beforeEach(() => {
  reset();
});

function dayBonus(count: number): number {
  return calculateDailyBonusCents(count, WOODLAND_RULE);
}

// A fixed "now" so window math is deterministic regardless of when tests run.
const NOW = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15

describe('parsePayPeriodFilter', () => {
  it('narrows known values and defaults unknowns to current', () => {
    expect(parsePayPeriodFilter('current')).toBe('current');
    expect(parsePayPeriodFilter('year')).toBe('year');
    expect(parsePayPeriodFilter('all')).toBe('all');
    expect(parsePayPeriodFilter('bogus')).toBe('current');
    expect(parsePayPeriodFilter(null)).toBe('current');
    expect(parsePayPeriodFilter(undefined)).toBe('current');
  });

  it('every MONTH_FILTERS value round-trips', () => {
    for (const f of MONTH_FILTERS) expect(parsePayPeriodFilter(f)).toBe(f);
  });
});

describe('payPeriodWindow', () => {
  it('current = the anchor UTC month', () => {
    const w = payPeriodWindow('current', NOW);
    expect(w.gte).toEqual(new Date(Date.UTC(2026, 5, 1)));
    expect(w.lt).toEqual(new Date(Date.UTC(2026, 6, 1)));
  });
  it('year = the anchor UTC calendar year', () => {
    const w = payPeriodWindow('year', NOW);
    expect(w.gte).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(w.lt).toEqual(new Date(Date.UTC(2027, 0, 1)));
  });
  it('all = unbounded', () => {
    const w = payPeriodWindow('all', NOW);
    expect(w.gte).toBeUndefined();
    expect(w.lt).toBeUndefined();
  });
});

describe('listBonusPayPeriods — filters', () => {
  it('current returns only the anchor month', async () => {
    addMonth({ year: 2026, month0: 5 }); // June (current)
    addMonth({ year: 2026, month0: 4 }); // May
    addMonth({ year: 2025, month0: 11 }); // last Dec
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monthStart).toEqual(um(2026, 5));
  });

  it('year returns every month in the anchor year, newest-first', async () => {
    addMonth({ year: 2026, month0: 5 }); // June
    addMonth({ year: 2026, month0: 0 }); // Jan
    addMonth({ year: 2026, month0: 2 }); // Mar
    addMonth({ year: 2025, month0: 11 }); // excluded (prior year)
    const rows = await listBonusPayPeriods(WOODLAND, 'year', NOW);
    expect(rows.map((r) => r.monthStart)).toEqual([um(2026, 5), um(2026, 2), um(2026, 0)]);
  });

  it('all returns every month regardless of date, newest-first', async () => {
    addMonth({ year: 2026, month0: 5 });
    addMonth({ year: 2024, month0: 1 });
    addMonth({ year: 2025, month0: 8 });
    const rows = await listBonusPayPeriods(WOODLAND, 'all', NOW);
    expect(rows.map((r) => r.monthStart)).toEqual([um(2026, 5), um(2025, 8), um(2024, 1)]);
  });
});

describe('listBonusPayPeriods — site scoping (hard rule #2)', () => {
  it('never returns a non-Woodland month', async () => {
    addMonth({ year: 2026, month0: 5, site_id: WOODLAND });
    addMonth({ year: 2026, month0: 5, site_id: EUGENE });
    const rows = await listBonusPayPeriods(WOODLAND, 'all', NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBeDefined();
  });
});

describe('listBonusPayPeriods — payout', () => {
  it('prefers the locked total_payout_cents when present', async () => {
    const m = addMonth({ year: 2026, month0: 5, state: 'signed', total_payout_cents: 12345 });
    addEntry(m.id, 80); // would compute to a different number, must be ignored
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.totalPayoutCents).toBe(12345);
    expect(rows[0]!.totalIsLocked).toBe(true);
  });

  it('computes from entries via the calculator when no locked total', async () => {
    const m = addMonth({ year: 2026, month0: 5, state: 'draft', total_payout_cents: null });
    addEntry(m.id, 60); // 10 * 50c = 500
    addEntry(m.id, 80); // (30*50)+(6*25) = 1650
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.totalPayoutCents).toBe(dayBonus(60) + dayBonus(80));
    expect(rows[0]!.totalIsLocked).toBe(false);
  });

  it('resolves to $0 (no throw) for a month with entries but no active rule', async () => {
    ruleStore.clear(); // no rule covers anything
    const m = addMonth({ year: 2026, month0: 5, state: 'draft', total_payout_cents: null });
    addEntry(m.id, 80);
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.totalPayoutCents).toBe(0);
    expect(rows[0]!.totalIsLocked).toBe(false);
  });

  it('resolves to $0 for an empty month', async () => {
    addMonth({ year: 2026, month0: 5, state: 'draft', total_payout_cents: null });
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.totalPayoutCents).toBe(0);
  });
});

describe('listBonusPayPeriods — signature status', () => {
  it('none when neither signer set', async () => {
    addMonth({ year: 2026, month0: 5, state: 'pending_signatures' });
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.signatureStatus).toBe('none');
    expect(rows[0]!.janetteSigned).toBe(false);
    expect(rows[0]!.morenaSigned).toBe(false);
  });

  it('partial when exactly one signer set', async () => {
    addMonth({ year: 2026, month0: 5, state: 'partially_signed', janette: 'user-jan' });
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.signatureStatus).toBe('partial');
    expect(rows[0]!.janetteSigned).toBe(true);
    expect(rows[0]!.morenaSigned).toBe(false);
  });

  it('complete when both signers set', async () => {
    addMonth({
      year: 2026,
      month0: 5,
      state: 'signed',
      janette: 'user-jan',
      morena: 'user-mor',
    });
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.signatureStatus).toBe('complete');
  });
});

describe('listBonusPayPeriods — amendment linkage (§6)', () => {
  it('flags an amendment and exposes the prior month id', async () => {
    const prior = addMonth({ year: 2026, month0: 4, state: 'amended' });
    addMonth({
      year: 2026,
      month0: 4,
      state: 'signed',
      amended_from: prior.id,
      janette: 'j',
      morena: 'm',
    });
    const rows = await listBonusPayPeriods(WOODLAND, 'year', NOW);
    const amendment = rows.find((r) => r.isAmendment);
    expect(amendment).toBeDefined();
    expect(amendment!.amendedFromMonthId).toBe(prior.id);
  });

  it('non-amended months report isAmendment=false and null prior id', async () => {
    addMonth({ year: 2026, month0: 5, state: 'paid', janette: 'j', morena: 'm' });
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.isAmendment).toBe(false);
    expect(rows[0]!.amendedFromMonthId).toBeNull();
  });
});

describe('listBonusPayPeriods — row shape', () => {
  it('carries label + state through', async () => {
    addMonth({ year: 2026, month0: 5, state: 'paid' });
    const rows = await listBonusPayPeriods(WOODLAND, 'current', NOW);
    expect(rows[0]!.label).toBe('June 2026');
    expect(rows[0]!.state).toBe('paid');
  });
});

// Type-only assertion: MonthFilter is the union we expect.
const _filters: MonthFilter[] = ['current', 'year', 'all'];
void _filters;
