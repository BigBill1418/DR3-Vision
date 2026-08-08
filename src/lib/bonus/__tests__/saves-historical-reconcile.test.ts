// ADR-0083 — the historical-parity property the migration rests on.
//
// THE HAZARD: `reconcile-fetch.ts` independently RECOMPUTES a period's grand
// total and compares it to the `total_payout_cents` locked at signature time. On
// a disagreement it fires an URGENT `dr3-vision-system` page and REFUSES to
// render or deliver the payroll PDF (ADR-0033). That tripwire is exactly what
// you want — and exactly what makes adding a term to the payout formula
// dangerous.
//
// Every already-signed period was locked by the pre-ADR-0083 formula
// (`bonus(mattress_count)`). The recompute now evaluates
// `bonus(mattress_count + saves)`. Those two agree for a historical row IF AND
// ONLY IF its `saves` is genuinely 0. It is: the column ships NOT NULL DEFAULT 0
// and the backfill is a REAL zero, because every historical row was keyed on a
// floor that was not capturing saves for bonus at all (see the 20260836
// migration for the full argument).
//
// If that reasoning were wrong — a nullable column, a non-zero backfill, a
// `?? 0` that quietly became a `?? something` — then EVERY signed period in the
// system would report drifted on its next PDF render, page Bill URGENT, and
// refuse to produce payroll. This file is the guard on that.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';

const publishNtfyMock = vi.fn<(args: Record<string, unknown>) => Promise<{ ok: boolean; outcome: 'sent' }>>(
  async () => ({ ok: true, outcome: 'sent' as const }),
);
vi.mock('@/lib/ntfy', () => ({
  publishNtfy: (args: Record<string, unknown>) => publishNtfyMock(args),
}));

const WOODLAND = {
  threshold_low: 50,
  rate_low: '0.50',
  threshold_high: 74,
  rate_high: '0.25',
};

vi.mock('@/lib/bonus/daily-entry', () => ({
  resolveActiveRule: async () => ({
    id: 'rule-1',
    effective_date: new Date('2026-01-01'),
    ...WOODLAND,
  }),
}));

interface MonthRow {
  id: string;
  state: string;
  site_id: string;
  period_start: Date;
  total_payout_cents: number | null;
  imported_with_legacy_formula: boolean;
}

let monthRow: MonthRow | null = null;
// REAL Prisma Decimals, not a `{ toNumber() }` stand-in: a hand-rolled double
// would satisfy the coercion helper even if the production code had reverted to
// a raw-Decimal read, which is the bug this whole area exists to prevent.
let entryRows: { mattress_count: Prisma.Decimal; saves: Prisma.Decimal }[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusPayPeriod: { findUnique: vi.fn(async () => monthRow) },
    bonusDailyEntry: { findMany: vi.fn(async () => entryRows) },
  },
}));

import { assertPayoutReconciles, recomputePeriodTotals } from '@/lib/bonus/reconcile-fetch';

const dec = (n: number) => new Prisma.Decimal(n);

/** A real-shaped Woodland period: a spread of days across both tiers. */
const HISTORICAL_COUNTS = [74, 99, 55, 120, 51, 0, 200, 76, 40, 88];

/** What the PRE-ADR-0083 formula locked for those counts. */
const LEGACY_LOCKED_CENTS = HISTORICAL_COUNTS.reduce(
  (sum, c) => sum + calculateDailyBonusCents(c, WOODLAND),
  0,
);

function seedHistoricalPeriod(state = 'signed') {
  monthRow = {
    id: 'period-historical',
    state,
    site_id: 'site-woodland',
    period_start: new Date('2026-06-09'),
    total_payout_cents: LEGACY_LOCKED_CENTS,
    imported_with_legacy_formula: false,
  };
  // The backfilled state of every pre-migration row: a real zero.
  entryRows = HISTORICAL_COUNTS.map((c) => ({ mattress_count: dec(c), saves: dec(0) }));
}

beforeEach(() => {
  publishNtfyMock.mockClear();
  monthRow = null;
  entryRows = [];
});

describe('historical signed periods reconcile at ZERO drift after ADR-0083', () => {
  it('recomputes a backfilled period to exactly its locked total', () => {
    seedHistoricalPeriod();
    expect(LEGACY_LOCKED_CENTS).toBeGreaterThan(0); // the fixture must be non-trivial

    return recomputePeriodTotals('period-historical').then((period) => {
      expect(period.recomputedTotalCents).toBe(LEGACY_LOCKED_CENTS);
      expect(period.recomputedTotalCents - (period.lockedTotalCents ?? 0)).toBe(0);
    });
  });

  it('passes the ADR-0033 gate and fires NO page', async () => {
    seedHistoricalPeriod();
    const result = await assertPayoutReconciles('period-historical');

    expect(result.pass).toBe(true);
    expect(result.verdict.ok).toBe(true);
    // The observable end state that matters: Bill's phone stayed quiet and the
    // payroll PDF was not refused.
    expect(publishNtfyMock).not.toHaveBeenCalled();
  });

  it('the recompute still SEES saves — parity is not achieved by ignoring the column', async () => {
    // A recompute that simply never read `saves` would also produce zero drift
    // on historical rows, and would be catastrophically wrong on new ones. This
    // distinguishes "correct" from "accidentally passing": give the same period
    // a real saves figure and the recompute must move.
    seedHistoricalPeriod();
    entryRows = [{ mattress_count: dec(40), saves: dec(20) }];

    const period = await recomputePeriodTotals('period-historical');
    // 60 paid units → (60-50) * $0.50 = $5.00. Processed-only would be $0.00.
    expect(period.recomputedTotalCents).toBe(500);
    expect(period.recomputedTotalCents).not.toBe(calculateDailyBonusCents(40, WOODLAND));
  });

  it('a period whose lock EXCLUDED a real save is correctly reported as drifted', async () => {
    // The tripwire must still work. A period locked at the processed-only total
    // while its entries carry saves is a genuine disagreement and must page.
    monthRow = {
      id: 'period-drifted',
      state: 'signed',
      site_id: 'site-woodland',
      period_start: new Date('2026-06-09'),
      total_payout_cents: calculateDailyBonusCents(40, WOODLAND), // = 0, processed-only
      imported_with_legacy_formula: false,
    };
    entryRows = [{ mattress_count: dec(40), saves: dec(20) }];

    const result = await assertPayoutReconciles('period-drifted');
    expect(result.pass).toBe(false);
    expect(publishNtfyMock).toHaveBeenCalledTimes(1);
  });
});
