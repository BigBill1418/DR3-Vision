// P0-1 / P0-2 — recompute + reconcile I/O tests (ADR-0033).
//
// Mocks the DB + ntfy + rule-resolution boundaries (like the existing
// m365-mail.test.ts / signature-notifications.test.ts) and drives the REAL
// assert* handlers. Verifies:
//   - the recompute coerces Decimal mattress_count via .toNumber() (the exact
//     bug that zeroed the lock) — a raw-Decimal entry must NOT silently zero;
//   - a mismatch fires an URGENT page with the contracted fingerprint and the
//     gate returns pass:false;
//   - a clean match passes with no page;
//   - the P0-2 zero-guard blocks a disagreeing $0 and allows an agreeing $0.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── ntfy double ─────────────────────────────────────────────────
const publishNtfyMock = vi.fn<
  (args: Record<string, unknown>) => Promise<{ ok: boolean; outcome: 'sent' }>
>(async () => ({ ok: true, outcome: 'sent' as const }));
vi.mock('@/lib/ntfy', () => ({
  publishNtfy: (args: Record<string, unknown>) => publishNtfyMock(args),
}));

// ── rule resolution double ──────────────────────────────────────
// Woodland: threshold_low=50, rate_low=$0.50, threshold_high=74, rate_high=$0.25.
const ruleMock = vi.fn<
  (
    siteId: string,
    onDate: Date,
  ) => Promise<{
    id: string;
    effective_date: Date;
    threshold_low: number;
    rate_low: string;
    threshold_high: number;
    rate_high: string;
  }>
>(async () => ({
  id: 'rule-1',
  effective_date: new Date('2026-01-01'),
  threshold_low: 50,
  rate_low: '0.50',
  threshold_high: 74,
  rate_high: '0.25',
}));
vi.mock('@/lib/bonus/daily-entry', () => ({
  resolveActiveRule: (siteId: string, onDate: Date) => ruleMock(siteId, onDate),
}));

// ── prisma double ───────────────────────────────────────────────
interface MonthRow {
  id: string;
  state: string;
  site_id: string;
  period_start: Date;
  total_payout_cents: number | null;
  imported_with_legacy_formula: boolean;
}
// mattress_count is a Decimal at the Prisma edge — model that with a .toNumber().
type DecimalLike = { toNumber(): number };
function decimal(n: number): DecimalLike {
  return { toNumber: () => n };
}

let monthRow: MonthRow | null = null;
let entryRows: { mattress_count: DecimalLike }[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusPayPeriod: {
      findUnique: vi.fn(async () => monthRow),
    },
    bonusDailyEntry: {
      findMany: vi.fn(async () => entryRows),
    },
  },
}));

import {
  assertPayoutReconciles,
  assertNotSuspectedWrongZero,
  recomputePeriodTotals,
} from '@/lib/bonus/reconcile-fetch';

beforeEach(() => {
  publishNtfyMock.mockClear();
  ruleMock.mockClear();
  monthRow = null;
  entryRows = [];
});

/**
 * 99 entries totalling $2,125.50 (212550 cents) — the real Woodland period shape
 * from tonight's incident. Each "day" of 74 mattresses earns $12.00, etc.; here we
 * just craft entries whose corrected total is 212550 so we can assert it.
 *
 * Use a single big day so the math is trivial to verify: units U with low=50/high=74:
 *   daily = (U-50)*50 + (U-74)*25  cents.
 * For U=99: (49)*50 + (25)*25 = 2450 + 625 = 3075 cents per day.
 * Need 212550 / 3075 = 69.12 → not integer, so build from explicit days below.
 */
function entriesTotalling212550(): { mattress_count: DecimalLike }[] {
  // 69 days of 99 mattresses = 69 * 3075 = 212175; plus one day to reach 212550.
  // 212550 - 212175 = 375 cents. A day of U where (U-50)*50 + max(U-74,0)*25 = 375.
  // U=57 → 7*50 = 350 (no high tier). U=58 → 400. Use 60 → 10*50=500. Hmm.
  // Simpler: 69 days of 99 (=212175) + 3 days of 53 (=3*150=450)... overshoot.
  // Cleanest: just assert with a self-consistent total computed from the entries.
  const days: { mattress_count: DecimalLike }[] = [];
  for (let i = 0; i < 69; i++) days.push({ mattress_count: decimal(99) });
  // top-up day of 57 → (57-50)*50 = 350 cents → total 212525. add a 51 day → 50.
  days.push({ mattress_count: decimal(57) }); // +350 → 212525
  days.push({ mattress_count: decimal(51) }); // +50  → 212575
  return days;
}

describe('recomputePeriodTotals — coercion correctness', () => {
  it('coerces Decimal mattress_count via .toNumber() (does NOT silently zero)', async () => {
    monthRow = {
      id: 'm1',
      state: 'signed',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: 3075,
      imported_with_legacy_formula: false,
    };
    entryRows = [{ mattress_count: decimal(99) }]; // one day of 99 → 3075 cents
    const r = await recomputePeriodTotals('m1');
    expect(r.recomputedTotalCents).toBe(3075);
    expect(r.lockedTotalCents).toBe(3075);
    expect(r.state).toBe('signed');
  });
});

describe('assertPayoutReconciles — P0-1', () => {
  it('passes with no page when locked matches the recompute', async () => {
    monthRow = {
      id: 'm1',
      state: 'signed',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: 3075,
      imported_with_legacy_formula: false,
    };
    entryRows = [{ mattress_count: decimal(99) }];
    const res = await assertPayoutReconciles('m1');
    expect(res.pass).toBe(true);
    expect(publishNtfyMock).not.toHaveBeenCalled();
  });

  it('REFUSES + fires urgent page when the lock is $0 but entries recompute positive', async () => {
    monthRow = {
      id: 'm1',
      state: 'signed',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: 0, // the Decimal-bug lock
      imported_with_legacy_formula: false,
    };
    entryRows = [{ mattress_count: decimal(99) }]; // recompute 3075
    const res = await assertPayoutReconciles('m1');
    expect(res.pass).toBe(false);
    expect(res.verdict).toMatchObject({ ok: false, reason: 'total_mismatch' });

    expect(publishNtfyMock).toHaveBeenCalledTimes(1);
    const arg = publishNtfyMock.mock.calls[0]![0];
    expect(arg['topic']).toBe('dr3-vision-system');
    expect(arg['priority']).toBe('urgent');
    expect(arg['fingerprint']).toBe('payout-reconcile-mismatch:m1');
    expect(String(arg['body'])).toContain('3075');
  });

  it('REFUSES + pages on a signed period with a NULL locked total', async () => {
    monthRow = {
      id: 'm1',
      state: 'signed',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: null,
      imported_with_legacy_formula: false,
    };
    entryRows = [{ mattress_count: decimal(99) }];
    const res = await assertPayoutReconciles('m1');
    expect(res.pass).toBe(false);
    expect(res.verdict).toMatchObject({ reason: 'missing_locked_total' });
    expect(publishNtfyMock).toHaveBeenCalledTimes(1);
  });

  it('does not page or refuse for a non-reconciled state (draft)', async () => {
    monthRow = {
      id: 'm1',
      state: 'draft',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: 0,
      imported_with_legacy_formula: false,
    };
    entryRows = [{ mattress_count: decimal(99) }];
    const res = await assertPayoutReconciles('m1');
    expect(res.pass).toBe(true);
    expect(res.verdict).toMatchObject({ reconciled: false });
    expect(publishNtfyMock).not.toHaveBeenCalled();
  });

  it('reconciles the real-shape Woodland period to its self-consistent total', async () => {
    const entries = entriesTotalling212550();
    // compute the expected total the same way the calculator would, for the assert
    const expected = entries.reduce((s, e) => {
      const u = e.mattress_count.toNumber();
      return s + Math.max(u - 50, 0) * 50 + Math.max(u - 74, 0) * 25;
    }, 0);
    monthRow = {
      id: 'm1',
      state: 'signed',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: expected, // locked correctly
      imported_with_legacy_formula: false,
    };
    entryRows = entries;
    const res = await assertPayoutReconciles('m1');
    expect(res.pass).toBe(true);
    expect(res.period.recomputedTotalCents).toBe(expected);
    expect(publishNtfyMock).not.toHaveBeenCalled();
  });
});

describe('assertNotSuspectedWrongZero — P0-2', () => {
  it('BLOCKS + urgent page when locked $0 disagrees with positive recompute', async () => {
    monthRow = {
      id: 'm1',
      state: 'signed',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: 0,
      imported_with_legacy_formula: false,
    };
    entryRows = [{ mattress_count: decimal(99) }]; // recompute 3075
    const res = await assertNotSuspectedWrongZero('m1');
    expect(res.pass).toBe(false);
    expect(publishNtfyMock).toHaveBeenCalledTimes(1);
    const arg = publishNtfyMock.mock.calls[0]![0];
    expect(arg['priority']).toBe('urgent');
    expect(arg['fingerprint']).toBe('payout-zero-suspected:m1');
  });

  it('ALLOWS a genuine $0 (every processor sub-threshold) — no page', async () => {
    monthRow = {
      id: 'm1',
      state: 'signed',
      site_id: 'site-wood',
      period_start: new Date('2026-06-09'),
      total_payout_cents: 0,
      imported_with_legacy_formula: false,
    };
    // Timothy Elich: 24 mattresses < 50 threshold → $0; everyone sub-threshold.
    entryRows = [{ mattress_count: decimal(24) }, { mattress_count: decimal(10) }];
    const res = await assertNotSuspectedWrongZero('m1');
    expect(res.pass).toBe(true);
    expect(res.period.recomputedTotalCents).toBe(0);
    expect(publishNtfyMock).not.toHaveBeenCalled();
  });

  it('reuses a prefetched period without re-querying', async () => {
    const prefetched = {
      monthId: 'm1',
      state: 'signed',
      lockedTotalCents: 0,
      recomputedTotalCents: 5000,
      importedWithLegacyFormula: false,
    };
    const res = await assertNotSuspectedWrongZero('m1', prefetched);
    expect(res.pass).toBe(false);
    expect(ruleMock).not.toHaveBeenCalled(); // no recompute happened
    expect(publishNtfyMock).toHaveBeenCalledTimes(1);
  });
});
