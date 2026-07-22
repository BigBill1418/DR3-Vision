// ADR-0046 Amendment 5 (D-M5-4) — variance detection: pure either-trips evaluation,
// established-baseline gating (>= 3 invoices), per-vendor threshold overrides, and
// the panel context loader.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeDb } from './__testutils__/fake-prisma';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  BASELINE_MIN_INVOICES,
  VARIANCE_FLAT_THRESHOLD_CENTS,
  VARIANCE_PERCENT_THRESHOLD,
  evaluateVariance,
  evaluateVarianceForDecision,
  loadEstablishedBaseline,
  loadVarianceContext,
  normalizeVendorName,
  type EstablishedBaseline,
} from './variance';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

const baseline = (over: Partial<EstablishedBaseline> = {}): EstablishedBaseline => ({
  vendorDisplayName: 'Clark Pest',
  invoiceCount: 6,
  meanAmountCents: 20000, // $200.00
  flatThresholdCents: VARIANCE_FLAT_THRESHOLD_CENTS,
  percentThreshold: VARIANCE_PERCENT_THRESHOLD,
  ...over,
});

describe('normalizeVendorName', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeVendorName('  Clark   Pest  ')).toBe('clark pest');
    expect(normalizeVendorName('SUNBELT Rentals')).toBe('sunbelt rentals');
  });
});

describe('evaluateVariance (pure, either-trips)', () => {
  it('does NOT trip within both thresholds ($200 baseline, $210 invoice = +$10/5%)', () => {
    const e = evaluateVariance(baseline(), 21000);
    expect(e.tripped).toBe(false);
    expect(e.direction).toBe('over');
    expect(e.varianceAbsCents).toBe(1000);
    expect(e.variancePct).toBeCloseTo(0.05, 5);
  });

  it('trips on the FLAT threshold when percent is within bounds', () => {
    // Baseline $1,000; invoice $1,060 = +$60 (>$50) but only +6% (<15%).
    const e = evaluateVariance(baseline({ meanAmountCents: 100000 }), 106000);
    expect(e.tripped).toBe(true);
    expect(e.varianceAbsCents).toBe(6000);
  });

  it('trips on the PERCENT threshold when the flat amount is within bounds', () => {
    // Baseline $40; invoice $48 = +$8 (<$50) but +20% (>15%).
    const e = evaluateVariance(baseline({ meanAmountCents: 4000 }), 4800);
    expect(e.tripped).toBe(true);
    expect(e.variancePct).toBeCloseTo(0.2, 5);
  });

  it('flags an under-billing too (direction=under)', () => {
    const e = evaluateVariance(baseline({ meanAmountCents: 100000 }), 90000); // -$100 / -10%
    expect(e.tripped).toBe(true); // $100 > $50 flat
    expect(e.direction).toBe('under');
  });

  it('honors a tighter per-vendor override (Clark Pest $25 flat + 6.25%)', () => {
    const b = baseline({ flatThresholdCents: 2500, percentThreshold: 0.0625 });
    // $206 = +$6 (<$25 default flat WOULD not trip) but +3% (<6.25%) → no trip.
    expect(evaluateVariance(b, 20600).tripped).toBe(false);
    // $214 = +$14 (<$25) but +7% (>6.25%) → trips on the tighter percent.
    expect(evaluateVariance(b, 21400).tripped).toBe(true);
  });
});

describe('loadEstablishedBaseline (prisma-backed)', () => {
  it('returns null for a vendor with fewer than 3 invoices (insufficient data)', async () => {
    const db = newFakeDb({
      baselines: [
        {
          vendor_name_normalized: 'clark pest',
          vendor_display_name: 'Clark Pest',
          invoice_count: BASELINE_MIN_INVOICES - 1,
          mean_amount_cents: 20000,
          median_amount_cents: 20000,
          min_amount_cents: 19000,
          max_amount_cents: 21000,
          stddev_amount_cents: null,
          variance_flat_override_cents: null,
          variance_percent_override: null,
        },
      ],
    });
    expect(await loadEstablishedBaseline(fp(db), 'Clark Pest')).toBeNull();
  });

  it('returns null for an unknown vendor', async () => {
    expect(await loadEstablishedBaseline(fp(newFakeDb()), 'Nobody')).toBeNull();
  });

  it('resolves per-vendor overrides against the global defaults', async () => {
    const db = newFakeDb({
      baselines: [
        {
          vendor_name_normalized: 'clark pest',
          vendor_display_name: 'Clark Pest',
          invoice_count: 8,
          mean_amount_cents: 20000,
          median_amount_cents: 20000,
          min_amount_cents: 18000,
          max_amount_cents: 22000,
          stddev_amount_cents: 1000,
          variance_flat_override_cents: 2500,
          variance_percent_override: 0.0625,
        },
      ],
    });
    const b = await loadEstablishedBaseline(fp(db), '  Clark  Pest ');
    expect(b).not.toBeNull();
    expect(b!.flatThresholdCents).toBe(2500);
    expect(b!.percentThreshold).toBeCloseTo(0.0625, 5);
  });
});

describe('evaluateVarianceForDecision (the decide-route gate)', () => {
  const dbWith = () =>
    newFakeDb({
      baselines: [
        {
          vendor_name_normalized: 'sunbelt rentals',
          vendor_display_name: 'Sunbelt Rentals',
          invoice_count: 5,
          mean_amount_cents: 20000,
          median_amount_cents: 20000,
          min_amount_cents: 18000,
          max_amount_cents: 22000,
          stddev_amount_cents: null,
          variance_flat_override_cents: null,
          variance_percent_override: null,
        },
      ],
    });

  it('not_applicable when no established baseline', async () => {
    const r = await evaluateVarianceForDecision(fp(newFakeDb()), 'Sunbelt Rentals', 999999);
    expect(r.state).toBe('not_applicable');
    expect(r.evaluation).toBeNull();
  });

  it('below_threshold within bounds', async () => {
    const r = await evaluateVarianceForDecision(fp(dbWith()), 'Sunbelt Rentals', 21000);
    expect(r.state).toBe('below_threshold');
  });

  it('above_threshold when the amount trips', async () => {
    const r = await evaluateVarianceForDecision(fp(dbWith()), 'Sunbelt Rentals', 50000);
    expect(r.state).toBe('above_threshold');
    expect(r.evaluation!.tripped).toBe(true);
  });
});

describe('loadVarianceContext (panel banner)', () => {
  it('returns established=false without a baseline', async () => {
    const ctx = await loadVarianceContext(fp(newFakeDb()), 'Nobody', 10000);
    expect(ctx.established).toBe(false);
  });

  it('returns the evaluation + last 3 recent invoices, newest first', async () => {
    const db = newFakeDb({
      baselines: [
        {
          vendor_name_normalized: 'clark pest',
          vendor_display_name: 'Clark Pest',
          invoice_count: 4,
          mean_amount_cents: 20000,
          median_amount_cents: 20000,
          min_amount_cents: 18000,
          max_amount_cents: 22000,
          stddev_amount_cents: null,
          variance_flat_override_cents: null,
          variance_percent_override: null,
        },
      ],
      baselineHistory: [
        { id: 'h1', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-01-10'), invoice_amount_cents: 19000 },
        { id: 'h2', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-04-10'), invoice_amount_cents: 20000 },
        { id: 'h3', vendor_name_normalized: 'clark pest', invoice_date: new Date('2026-07-10'), invoice_amount_cents: 21000 },
        { id: 'h4', vendor_name_normalized: 'clark pest', invoice_date: new Date('2025-12-10'), invoice_amount_cents: 18000 },
      ],
    });
    const ctx = await loadVarianceContext(fp(db), 'Clark Pest', 50000);
    expect(ctx.established).toBe(true);
    expect(ctx.evaluation!.tripped).toBe(true);
    expect(ctx.recent).toHaveLength(3);
    expect(ctx.recent![0]!.invoiceDate).toBe('2026-07-10'); // newest first
  });
});
