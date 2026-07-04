// ADR-0042 §7-b — the June-2026-Woodland acceptance fixture: the pre-filled
// inventory MUST reproduce 4,062. Plus headcount-pre-fill provenance + the
// month-boundary math.
//
// FIXTURE MATH (documented per the ADR): the pre-filled inventory is the ONE
// pool-aware running balance (ADR-0037 D6) as of the cover month's last day —
//   End = Start + Inbound + Dropoffs − Stripped − WholeUnitsSold − Landfilled
// We reproduce a real June by anchoring a PHYSICAL snapshot at the start of the
// month and letting June's movements net to the pool state:
//
//   anchor (2026-06-01, all program):  3000 indoor + 1000 outdoor + 0 in-proc = 4000
//   + verified inbound (program):      + 200
//   + consumer drop-offs (CIP pool):   +  10
//   − stripped (program):              − 140
//   − whole units sold:                −   0
//   − landfilled (program):            −   8
//   ─────────────────────────────────────────
//   program = 4000 + 200 + 10 − 140 − 0 − 8 = 4062 ; non-program = 0 ; TOTAL = 4062
//
// The DB adapter is exercised through mocked prisma aggregates that stand in for
// "June's post-anchor flow" — identical style to running-balance.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const D = (n: number | string) => new Prisma.Decimal(n);

interface Agg {
  _sum: Record<string, number | Prisma.Decimal | null>;
}

const store = {
  anchor: null as null | Record<string, unknown>,
  inbound: { program_unit_count: 0, non_program_unit_count: 0 } as Record<string, number | null>,
  dropoffs: { units: 0 } as Record<string, number | null>,
  stripped: { stripped_program: D(0), stripped_non_program: D(0) } as Record<string, Prisma.Decimal | null>,
  wholeUnitsSold: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  landfilled: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  closes: [] as Record<string, unknown>[],
  signer: null as null | { signer_name: string; signer_title: string },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteInventorySnapshot: { findFirst: async () => store.anchor },
    inboundLoad: { aggregate: async (): Promise<Agg> => ({ _sum: store.inbound }) },
    consumerDropoff: { aggregate: async (): Promise<Agg> => ({ _sum: store.dropoffs }) },
    processedUnitsDaily: {
      aggregate: async (): Promise<Agg> => ({ _sum: store.stripped }),
      findMany: async () => store.closes,
    },
    outboundMaterial: { aggregate: async (): Promise<Agg> => ({ _sum: store.wholeUnitsSold }) },
    landfilledUnit: { aggregate: async (): Promise<Agg> => ({ _sum: store.landfilled }) },
    corSiteConfig: { findUnique: async () => store.signer },
  },
}));

import { computeCorPrefill, coverMonthBounds } from './prefill';

describe('coverMonthBounds', () => {
  it('bounds June 2026 to [2026-06-01 .. 2026-06-30] with an end-of-day asOf', () => {
    const b = coverMonthBounds('2026-06-01');
    expect(b.monthStart.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(b.monthEndDate.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(b.monthEndAsOf.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('handles a 31-day month and a leap February', () => {
    expect(coverMonthBounds('2026-07-01').monthEndDate.toISOString().slice(0, 10)).toBe('2026-07-31');
    expect(coverMonthBounds('2024-02-01').monthEndDate.toISOString().slice(0, 10)).toBe('2024-02-29');
  });
});

describe('computeCorPrefill — June 2026 Woodland acceptance fixture (§7-b)', () => {
  beforeEach(() => {
    store.anchor = {
      id: 'snap-june-anchor',
      snapshot_at: new Date('2026-06-01T00:00:00Z'),
      units_indoor: 3000,
      units_outdoor: 1000,
      units_total: null,
      units_in_processing: 0,
      reconciled_delta: 0,
    };
    store.inbound = { program_unit_count: 200, non_program_unit_count: 0 };
    store.dropoffs = { units: 10 };
    store.stripped = { stripped_program: D('140.0'), stripped_non_program: D('0.0') };
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 8, non_program_units: 0 };
    store.closes = [
      { id: 'close-06-15', production_date: new Date('2026-06-15T00:00:00Z'), employees_count: 16, processors_count: 13 },
      { id: 'close-06-30', production_date: new Date('2026-06-30T00:00:00Z'), employees_count: 15, processors_count: 12 },
    ];
    store.signer = { signer_name: 'Rick Albritton', signer_title: 'Transportation Manager' };
  });

  it('reproduces inventory_units == 4062', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.inventoryUnits).toBe(4062);
    expect(p.inventorySource.computedTotal).toBe('4062');
    expect(p.inventorySource.computedProgram).toBe('4062');
    expect(p.inventorySource.computedNonProgram).toBe('0');
  });

  it('records the anchor snapshot id + reconcile delta + asOf in inventory_source', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.inventorySource.anchorSnapshotId).toBe('snap-june-anchor');
    expect(p.inventorySource.anchorPhysicalUnits).toBe(4000);
    expect(p.inventorySource.anchorReconciledDelta).toBe(0);
    expect(p.inventorySource.asOf).toBe('2026-06-30T23:59:59.999Z');
    expect(p.inventorySource.storedUnits).toBe(4062);
  });

  it('pre-fills headcount from the month-end close and retains the full series', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    // Month-end close is the LAST row (2026-06-30): 15 employees / 12 processors.
    expect(p.headcountSource.monthEndCloseId).toBe('close-06-30');
    expect(p.headcountSource.monthEndDate).toBe('2026-06-30');
    expect(p.headcountSource.employeesCount).toBe(15);
    expect(p.headcountSource.processorsCount).toBe(12);
    // Every consulted close row id is retained (the full month series).
    expect(p.headcountSource.consultedCloseRowIds).toEqual(['close-06-15', 'close-06-30']);
    expect(p.headcountSource.series).toHaveLength(2);
  });

  it('resolves the signer from config (D2.3)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });

  it('falls back to the seeded default signer when no config row exists', async () => {
    store.signer = null;
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });

  it('handles a month with no daily closes (headcount pre-fill is empty, not an error)', async () => {
    store.closes = [];
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.headcountSource.monthEndCloseId).toBeNull();
    expect(p.headcountSource.employeesCount).toBeNull();
    expect(p.headcountSource.consultedCloseRowIds).toEqual([]);
    // Inventory still computes independently.
    expect(p.inventoryUnits).toBe(4062);
  });
});
