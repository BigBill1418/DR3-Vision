// Rollup §3 (2026-07-21 handoff, §15 item 5) — floor inventory tile data.
//
// The tile must read THROUGH the one ADR-0037 running-balance computation, so
// these tests mock `@/lib/prisma` (same store shape as running-balance.test.ts)
// and drive the REAL `onHand` + `computeRunningBalance` pool math — Rick's
// 137 program / 1152 non-program morning and his 237-processed sequential-
// depletion illustration included. The §3 projection gets pure-function
// coverage of its own.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const D = (n: number | string) => new Prisma.Decimal(n);

interface Agg {
  _sum: Record<string, number | Prisma.Decimal | null>;
}
const store = {
  anchor: null as null | {
    snapshot_at: Date;
    units_indoor: number | null;
    units_total: number | null;
    units_in_processing: number;
    program_units?: Prisma.Decimal | null;
    non_program_units?: Prisma.Decimal | null;
    pool_attribution?: string;
  },
  inbound: { program_unit_count: 0, non_program_unit_count: 0 } as Record<string, number | null>,
  dropoffs: { units: 0 } as Record<string, number | null>,
  stripped: {
    stripped_program: D(0),
    stripped_non_program: D(0),
  } as Record<string, Prisma.Decimal | null>,
  wholeUnitsSold: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  landfilled: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  closes: [] as { stripped_program: Prisma.Decimal; stripped_non_program: Prisma.Decimal }[],
  lastClosesWhere: null as null | { site_id: string; production_date: { gte: Date; lte: Date } },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteInventorySnapshot: { findFirst: async () => store.anchor },
    inboundLoad: { aggregate: async (): Promise<Agg> => ({ _sum: store.inbound }) },
    consumerDropoff: { aggregate: async (): Promise<Agg> => ({ _sum: store.dropoffs }) },
    processedUnitsDaily: {
      aggregate: async (): Promise<Agg> => ({ _sum: store.stripped }),
      findMany: async ({
        where,
      }: {
        where: { site_id: string; production_date: { gte: Date; lte: Date } };
      }) => {
        store.lastClosesWhere = where;
        return store.closes;
      },
    },
    outboundMaterial: { aggregate: async (): Promise<Agg> => ({ _sum: store.wholeUnitsSold }) },
    landfilledUnit: { aggregate: async (): Promise<Agg> => ({ _sum: store.landfilled }) },
  },
}));

import {
  computeFloorInventoryTile,
  computeProgramPoolProjection,
} from './floor-inventory-tile';

beforeEach(() => {
  store.anchor = null;
  store.inbound = { program_unit_count: 0, non_program_unit_count: 0 };
  store.dropoffs = { units: 0 };
  store.stripped = { stripped_program: D(0), stripped_non_program: D(0) };
  store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
  store.landfilled = { program_units: 0, non_program_units: 0 };
  store.closes = [];
  store.lastClosesWhere = null;
});

// Rick's morning: a measured physical count of 137 program + 1152 non-program.
function rickMorningAnchor() {
  store.anchor = {
    snapshot_at: new Date('2026-07-20T14:00:00Z'),
    units_indoor: null,
    units_total: 1289,
    units_in_processing: 0,
    program_units: D(137),
    non_program_units: D(1152),
    pool_attribution: 'measured',
  };
}

describe('computeFloorInventoryTile — pools come from the ADR-0037 running balance', () => {
  it("shows Rick's 137 program / 1152 non-program / 1289 total, measured anchor", async () => {
    rickMorningAnchor();
    const tile = await computeFloorInventoryTile('S1', { now: new Date('2026-07-21T00:00:00Z') });
    expect(tile.programOnFloor).toBe(137);
    expect(tile.nonProgramOnFloor).toBe(1152);
    expect(tile.totalOnFloor).toBe(1289);
    expect(tile.anchorPool).toBe('measured');
  });

  it("sequential depletion (Rick's 237-processed day): 137 program + 100 non-program stripped → 0 / 1052 on floor", async () => {
    // The Kelsey-Q1 split is what the daily close RECORDS; the tile just
    // subtracts the recorded splits per pool — same math, same numbers.
    rickMorningAnchor();
    store.stripped = { stripped_program: D(137), stripped_non_program: D(100) };
    const tile = await computeFloorInventoryTile('S1', { now: new Date('2026-07-21T00:00:00Z') });
    expect(tile.programOnFloor).toBe(0);
    expect(tile.nonProgramOnFloor).toBe(1052);
    expect(tile.totalOnFloor).toBe(1052);
  });

  it('inbound / dropoffs / sold / landfilled all flow through the shared pool math', async () => {
    rickMorningAnchor();
    store.inbound = { program_unit_count: 50, non_program_unit_count: 10 };
    store.dropoffs = { units: 5 }; // program pool (CIP)
    store.wholeUnitsSold = { program_units: 0, non_program_units: 12 };
    store.landfilled = { program_units: 2, non_program_units: 3 };
    const tile = await computeFloorInventoryTile('S1', { now: new Date('2026-07-21T00:00:00Z') });
    expect(tile.programOnFloor).toBe(190); // 137 + 50 + 5 − 2
    expect(tile.nonProgramOnFloor).toBe(1147); // 1152 + 10 − 12 − 3
    expect(tile.totalOnFloor).toBe(1337);
  });

  it('projects days of program pool remaining off the trailing TOTAL rate (program depletes first)', async () => {
    rickMorningAnchor();
    // One trailing close at Rick's 237/day pace: at that pace, 137 program is
    // gone in 137/237 ≈ 0.578 days.
    store.closes = [{ stripped_program: D(137), stripped_non_program: D(100) }];
    const tile = await computeFloorInventoryTile('S1', { now: new Date('2026-07-21T00:00:00Z') });
    expect(tile.trailingUnitsPerDay).toBe(237);
    expect(tile.programDaysRemaining).toBeCloseTo(137 / 237, 10);
  });

  it('scopes the trailing-closes read to the site and a 7-day inclusive window', async () => {
    rickMorningAnchor();
    await computeFloorInventoryTile('S1', { now: new Date('2026-07-21T12:00:00Z') });
    expect(store.lastClosesWhere?.site_id).toBe('S1');
    const w = store.lastClosesWhere!.production_date;
    expect((w.lte.getTime() - w.gte.getTime()) / 86_400_000).toBe(6);
  });

  it('is null-safe with no anchor, no flows, no closes', async () => {
    const tile = await computeFloorInventoryTile('S1', { now: new Date('2026-07-21T00:00:00Z') });
    expect(tile.programOnFloor).toBe(0);
    expect(tile.nonProgramOnFloor).toBe(0);
    expect(tile.totalOnFloor).toBe(0);
    expect(tile.trailingUnitsPerDay).toBeNull();
    expect(tile.programDaysRemaining).toBeNull();
  });
});

describe('computeProgramPoolProjection — pure §3 projection', () => {
  it('no closes → both null (no rate to project from)', () => {
    expect(computeProgramPoolProjection(D(137), [])).toEqual({
      trailingUnitsPerDay: null,
      programDaysRemaining: null,
    });
  });

  it('mean of total stripped across closes, program ÷ rate', () => {
    const p = computeProgramPoolProjection(D(300), [
      { stripped_program: D(150), stripped_non_program: D(10) },
      { stripped_program: D(120), stripped_non_program: D(20) },
    ]);
    expect(p.trailingUnitsPerDay).toBe(150); // (160 + 140) / 2
    expect(p.programDaysRemaining).toBe(2); // 300 / 150
  });

  it('all-zero closes → rate 0, days null (never divides by zero)', () => {
    const p = computeProgramPoolProjection(D(137), [
      { stripped_program: D(0), stripped_non_program: D(0) },
    ]);
    expect(p.trailingUnitsPerDay).toBe(0);
    expect(p.programDaysRemaining).toBeNull();
  });

  it('a negative program pool (ledger drift) clamps to 0 days, never negative', () => {
    const p = computeProgramPoolProjection(D(-12), [
      { stripped_program: D(100), stripped_non_program: D(0) },
    ]);
    expect(p.programDaysRemaining).toBe(0);
  });

  it('fractional Decimal(7,1) flows stay exact through the Decimal math', () => {
    const p = computeProgramPoolProjection(D('10.5'), [
      { stripped_program: D('3.5'), stripped_non_program: D('0') },
    ]);
    expect(p.trailingUnitsPerDay).toBe(3.5);
    expect(p.programDaysRemaining).toBe(3);
  });
});
