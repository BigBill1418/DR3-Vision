// ADR-0042 §7-b (amended 2026-07-18) — the June-2026-Woodland acceptance fixture:
// the pre-filled inventory MUST reproduce the CORRECTED close 3,977 (3,748 program
// + 229 non-program). ADR-0037's amendment corrected the buggy 4,062 (the workbook
// grid double-counted DAY23's NP row); this fixture is updated to the corrected
// number and now cross-validates the D6 running balance (`onHand`) against the
// §2.3 workbook close (`computeInventoryClose`) using the SAME authoritative
// Processed-ledger totals. Plus headcount-pre-fill provenance + month-boundary math.
//
// FIXTURE MATH (documented per the ADR): the pre-filled inventory is the ONE
// pool-aware running balance (ADR-0037 D6) as of the cover month's last day —
//   End = Start + Inbound + Dropoffs − Stripped − WholeUnitsSold − Landfilled
// We reproduce the corrected June by anchoring a PHYSICAL snapshot at the month
// open (the Processed!D5 program opening) and letting June's Processed-ledger
// totals net to the pool state:
//
//   anchor (2026-06-01, program open, D5):        1423
//   + verified inbound program (Processed!F40):  +19451
//   + verified inbound non-program (G40):        +  229  → non-program pool
//   + consumer drop-offs (CIP pool):             +    0
//   − stripped program (Processed!D40):          −17126
//   − stripped non-program (E40):                −    0
//   − whole units sold / landfilled:             −    0
//   ────────────────────────────────────────────────────
//   program = 1423 + 19451 − 17126 = 3748 ; non-program = 229 ; TOTAL = 3977
//
// The DB adapter is exercised through mocked prisma aggregates that stand in for
// "June's post-anchor flow" — identical style to running-balance.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { InventorySource, HeadcountSource } from './prefill';

const D = (n: number | string) => new Prisma.Decimal(n);

interface Agg {
  _sum: Record<string, number | Prisma.Decimal | null>;
}

const store = {
  anchor: null as null | Record<string, unknown>,
  inbound: { program_unit_count: 0, non_program_unit_count: 0 } as Record<string, number | null>,
  dropoffs: { units: 0 } as Record<string, number | null>,
  stripped: { stripped_program: D(0), stripped_non_program: D(0) } as Record<
    string,
    Prisma.Decimal | null
  >,
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
    expect(coverMonthBounds('2026-07-01').monthEndDate.toISOString().slice(0, 10)).toBe(
      '2026-07-31',
    );
    expect(coverMonthBounds('2024-02-01').monthEndDate.toISOString().slice(0, 10)).toBe(
      '2024-02-29',
    );
  });
});

describe('computeCorPrefill — June 2026 Woodland acceptance fixture (§7-b)', () => {
  beforeEach(() => {
    store.anchor = {
      id: 'snap-june-anchor',
      snapshot_at: new Date('2026-06-01T00:00:00Z'),
      units_indoor: 1423, // Processed!D5 program opening = DAY1!L2
      units_outdoor: 0,
      units_total: null,
      units_in_processing: 0,
      reconciled_delta: 0,
    };
    store.inbound = { program_unit_count: 19451, non_program_unit_count: 229 }; // F40 / G40
    store.dropoffs = { units: 0 };
    store.stripped = { stripped_program: D('17126.0'), stripped_non_program: D('0.0') }; // D40 / E40
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 0, non_program_units: 0 };
    store.closes = [
      {
        id: 'close-06-15',
        production_date: new Date('2026-06-15T00:00:00Z'),
        employees_count: 16,
        processors_count: 13,
      },
      {
        id: 'close-06-30',
        production_date: new Date('2026-06-30T00:00:00Z'),
        employees_count: 15,
        processors_count: 12,
      },
    ];
    store.signer = { signer_name: 'Rick Albritton', signer_title: 'Transportation Manager' };
  });

  it('reproduces inventory_units == 3977 (3748 program + 229 non-program)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.inventorySource as InventorySource;
    expect(p.inventoryUnits).toBe(3977);
    expect(src.computedTotal).toBe('3977');
    expect(src.computedProgram).toBe('3748');
    expect(src.computedNonProgram).toBe('229');
  });

  it('records the anchor snapshot id + reconcile delta + asOf in inventory_source', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.inventorySource as InventorySource;
    expect(src.anchorSnapshotId).toBe('snap-june-anchor');
    expect(src.anchorPhysicalUnits).toBe(1423);
    expect(src.anchorReconciledDelta).toBe(0);
    expect(src.asOf).toBe('2026-06-30T23:59:59.999Z');
    expect(src.storedUnits).toBe(3977);
  });

  it('pre-fills headcount from the month-end close and retains the full series', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.headcountSource as HeadcountSource;
    // Month-end close is the LAST row (2026-06-30): 15 employees / 12 processors.
    expect(src.monthEndCloseId).toBe('close-06-30');
    expect(src.monthEndDate).toBe('2026-06-30');
    expect(src.employeesCount).toBe(15);
    expect(src.processorsCount).toBe(12);
    // Every consulted close row id is retained (the full month series).
    expect(src.consultedCloseRowIds).toEqual(['close-06-15', 'close-06-30']);
    expect(src.series).toHaveLength(2);
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
    const src = p.headcountSource as HeadcountSource;
    expect(src.monthEndCloseId).toBeNull();
    expect(src.employeesCount).toBeNull();
    expect(src.consultedCloseRowIds).toEqual([]);
    // Inventory still computes independently.
    expect(p.inventoryUnits).toBe(3977);
  });
});

describe('computeCorPrefill — mid-month filing (ADR-0042 amendment)', () => {
  beforeEach(() => {
    // A mid-month pre-fill must NOT read the balance/close ledger at all. Poison the
    // store so that any accidental balance/close query would produce a WRONG number
    // — the mid-month path must ignore it entirely.
    store.anchor = {
      id: 'snap-should-not-be-read',
      snapshot_at: new Date('2026-06-01T00:00:00Z'),
      units_indoor: 999999,
      units_outdoor: 0,
      units_total: null,
      units_in_processing: 0,
      reconciled_delta: 0,
    };
    store.inbound = { program_unit_count: 999999, non_program_unit_count: 999999 };
    store.closes = [
      {
        id: 'close-06-30',
        production_date: new Date('2026-06-30T00:00:00Z'),
        employees_count: 15,
        processors_count: 12,
      },
    ];
    store.signer = { signer_name: 'Rick Albritton', signer_title: 'Transportation Manager' };
  });

  it('files inventory + headcount BLANK and never computes a figure', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01', 'mid_month');
    expect(p.period).toBe('mid_month');
    expect(p.inventoryUnits).toBeNull();
    expect(p.inventorySource).toEqual({
      method: 'mid_month_blank_adr0042_amendment',
      note: expect.stringContaining('inventory is filed blank'),
    });
    expect(p.headcountSource).toEqual({
      method: 'mid_month_blank_adr0042_amendment',
      note: expect.stringContaining('FT/PT headcount is filed blank'),
    });
  });

  it('still resolves the signer (the mid-month form is signed by hand)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01', 'mid_month');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });

  it('falls back to the seeded default signer when no config row exists', async () => {
    store.signer = null;
    const p = await computeCorPrefill('site-woodland', '2026-06-01', 'mid_month');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });
});
