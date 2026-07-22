// ADR-0046 Amendment 5 (D-M5-4) — baseline aggregation + rebuild:
// trailing-12-month windowing, mean/median/min/max/stddev, the >=3 established
// gate lives in variance.ts (here we just compute count), override preservation on
// rebuild, stale removal, and the vision_approval history feed.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeDb } from './__testutils__/fake-prisma';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  computeBaselineForVendor,
  aggregateBaselines,
  rebuildVendorBaselines,
  recordVisionApproval,
  trailingWindowStart,
  type BaselineHistoryRow,
} from './baselines';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

const row = (norm: string, dateISO: string, cents: number, name = norm): BaselineHistoryRow => ({
  vendorName: name,
  vendorNameNormalized: norm,
  invoiceDate: new Date(`${dateISO}T00:00:00.000Z`),
  invoiceAmountCents: cents,
});

describe('trailingWindowStart', () => {
  it('is exactly 12 months before the anchor', () => {
    expect(trailingWindowStart(new Date('2026-07-10T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2025-07-10',
    );
  });
});

describe('computeBaselineForVendor', () => {
  it('returns null with no rows', () => {
    expect(computeBaselineForVendor([])).toBeNull();
  });

  it('computes mean/median/min/max/count over three invoices', () => {
    const agg = computeBaselineForVendor([
      row('clark pest', '2026-01-10', 19000),
      row('clark pest', '2026-04-10', 20000),
      row('clark pest', '2026-07-10', 21000),
    ]);
    expect(agg).not.toBeNull();
    expect(agg!.invoiceCount).toBe(3);
    expect(agg!.meanAmountCents).toBe(20000);
    expect(agg!.medianAmountCents).toBe(20000);
    expect(agg!.minAmountCents).toBe(19000);
    expect(agg!.maxAmountCents).toBe(21000);
  });

  it('EXCLUDES invoices older than 12 months before the vendor’s most recent', () => {
    // Anchor = 2026-07-10; window start = 2025-07-10. The 2025-06 row is out.
    const agg = computeBaselineForVendor([
      row('acme', '2025-06-01', 100000), // out of window
      row('acme', '2025-08-01', 10000),
      row('acme', '2026-01-01', 12000),
      row('acme', '2026-07-10', 14000),
    ]);
    expect(agg!.invoiceCount).toBe(3);
    expect(agg!.maxAmountCents).toBe(14000); // the $1000 outlier was excluded
    expect(agg!.meanAmountCents).toBe(12000);
  });

  it('median of an even count averages the two middles (rounded)', () => {
    const agg = computeBaselineForVendor([
      row('v', '2026-01-01', 100),
      row('v', '2026-02-01', 200),
      row('v', '2026-03-01', 300),
      row('v', '2026-04-01', 500),
    ]);
    expect(agg!.medianAmountCents).toBe(250); // (200+300)/2
  });

  it('stddev is null for a single-invoice window, a number otherwise', () => {
    expect(computeBaselineForVendor([row('solo', '2026-01-01', 5000)])!.stddevAmountCents).toBeNull();
    const agg = computeBaselineForVendor([
      row('pair', '2026-01-01', 10000),
      row('pair', '2026-02-01', 20000),
    ]);
    // population stddev of {100,200} = 50 dollars = 5000 cents.
    expect(agg!.stddevAmountCents).toBe(5000);
  });

  it('uses the freshest in-window spelling as the display name', () => {
    const agg = computeBaselineForVendor([
      row('clark pest', '2026-01-01', 100, 'clark pest'),
      row('clark pest', '2026-07-01', 100, 'Clark Pest Control'),
    ]);
    expect(agg!.vendorDisplayName).toBe('Clark Pest Control');
  });
});

describe('aggregateBaselines', () => {
  it('groups by normalized vendor and sorts by display name', () => {
    const aggs = aggregateBaselines([
      row('sunbelt', '2026-06-01', 5000, 'Sunbelt'),
      row('clark pest', '2026-06-01', 20000, 'Clark Pest'),
      row('clark pest', '2026-06-02', 22000, 'Clark Pest'),
    ]);
    expect(aggs.map((a) => a.vendorDisplayName)).toEqual(['Clark Pest', 'Sunbelt']);
    expect(aggs[0]!.invoiceCount).toBe(2);
  });
});

describe('rebuildVendorBaselines', () => {
  it('computes baselines from history and reports counts', async () => {
    const db = newFakeDb({
      baselineHistory: [
        { id: 'h1', vendor_name: 'Clark Pest', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-01-10'), invoice_amount_cents: 19000 },
        { id: 'h2', vendor_name: 'Clark Pest', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-04-10'), invoice_amount_cents: 20000 },
        { id: 'h3', vendor_name: 'Clark Pest', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-07-10'), invoice_amount_cents: 21000 },
      ],
    });
    const res = await rebuildVendorBaselines(fp(db));
    expect(res.vendorsComputed).toBe(1);
    expect(res.historyRows).toBe(3);
    expect(db.baselines).toHaveLength(1);
    expect(db.baselines[0]!.mean_amount_cents).toBe(20000);
    expect(db.baselines[0]!.invoice_count).toBe(3);
  });

  it('PRESERVES a per-vendor override across a rebuild', async () => {
    const db = newFakeDb({
      baselines: [
        {
          vendor_name_normalized: 'clark pest',
          vendor_display_name: 'Clark Pest',
          invoice_count: 3,
          mean_amount_cents: 20000,
          median_amount_cents: 20000,
          min_amount_cents: 19000,
          max_amount_cents: 21000,
          stddev_amount_cents: 816,
          variance_flat_override_cents: 2500, // admin-set: Clark Pest → $25 flat
          variance_percent_override: 0.0625, // 6.25%
        },
      ],
      baselineHistory: [
        { id: 'h1', vendor_name: 'Clark Pest', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-05-10'), invoice_amount_cents: 30000 },
        { id: 'h2', vendor_name: 'Clark Pest', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-06-10'), invoice_amount_cents: 31000 },
        { id: 'h3', vendor_name: 'Clark Pest', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-07-10'), invoice_amount_cents: 32000 },
      ],
    });
    await rebuildVendorBaselines(fp(db));
    const b = db.baselines.find((x) => x.vendor_name_normalized === 'clark pest')!;
    // Aggregate columns recomputed…
    expect(b.mean_amount_cents).toBe(31000);
    // …but the admin overrides SURVIVE.
    expect(b.variance_flat_override_cents).toBe(2500);
    expect(b.variance_percent_override).toBe(0.0625);
  });

  it('removes a stale baseline whose vendor no longer has history', async () => {
    const db = newFakeDb({
      baselines: [
        {
          vendor_name_normalized: 'gone vendor',
          vendor_display_name: 'Gone',
          invoice_count: 4,
          mean_amount_cents: 100,
          median_amount_cents: 100,
          min_amount_cents: 100,
          max_amount_cents: 100,
          stddev_amount_cents: 0,
          variance_flat_override_cents: null,
          variance_percent_override: null,
        },
      ],
      baselineHistory: [
        { id: 'h1', vendor_name: 'Still Here', vendor_name_normalized: 'still here', invoice_date: new Date('2026-07-01'), invoice_amount_cents: 500 },
      ],
    });
    const res = await rebuildVendorBaselines(fp(db));
    expect(res.staleRemoved).toBe(1);
    expect(db.baselines.map((b) => b.vendor_name_normalized)).toEqual(['still here']);
  });
});

describe('recordVisionApproval', () => {
  it('appends a vision_approval history row', async () => {
    const db = newFakeDb();
    await recordVisionApproval(fp(db), {
      vendorFreeform: '  Clark Pest  ',
      confirmedAmountCents: 21000,
      siteId: 'site-woodland',
      invoiceDate: new Date('2026-07-10'),
      actorUserId: 'u-bill',
    });
    expect(db.baselineHistory).toHaveLength(1);
    expect(db.baselineHistory[0]!.vendor_name_normalized).toBe('clark pest');
    expect(db.baselineHistory[0]!.source).toBe('vision_approval');
    expect(db.baselineHistory[0]!.invoice_amount_cents).toBe(21000);
  });

  it('is a no-op on a blank vendor or a non-finite amount', async () => {
    const db = newFakeDb();
    await recordVisionApproval(fp(db), {
      vendorFreeform: '   ',
      confirmedAmountCents: 100,
      siteId: 'x',
      invoiceDate: new Date(),
      actorUserId: 'u',
    });
    await recordVisionApproval(fp(db), {
      vendorFreeform: 'ACME',
      confirmedAmountCents: Number.NaN,
      siteId: 'x',
      invoiceDate: new Date(),
      actorUserId: 'u',
    });
    expect(db.baselineHistory).toHaveLength(0);
  });
});
