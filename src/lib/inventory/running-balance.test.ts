// ADR-0037 D6 (Addendum B4) — running-balance tests. The pure core gets
// property-style + real-Prisma.Decimal boundary coverage; onHand +
// reconcilePhysicalCount get a mocked-prisma smoke path.
//
//   End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const D = (n: number | string) => new Prisma.Decimal(n);

// ── mock store for onHand / reconcile ────────────────────────────────────
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
  createdSnapshots: [] as unknown[],
  auditRows: [] as unknown[],
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteInventorySnapshot: {
      findFirst: async () => store.anchor,
    },
    inboundLoad: { aggregate: async (): Promise<Agg> => ({ _sum: store.inbound }) },
    consumerDropoff: { aggregate: async (): Promise<Agg> => ({ _sum: store.dropoffs }) },
    processedUnitsDaily: { aggregate: async (): Promise<Agg> => ({ _sum: store.stripped }) },
    // WholeUnitsSold reads renovation-sub-category outbound rows.
    outboundMaterial: { aggregate: async (): Promise<Agg> => ({ _sum: store.wholeUnitsSold }) },
    landfilledUnit: { aggregate: async (): Promise<Agg> => ({ _sum: store.landfilled }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        siteInventorySnapshot: {
          create: async ({ data }: { data: unknown }) => {
            store.createdSnapshots.push(data);
            return { id: 'snap-1' };
          },
        },
        auditLog: {
          create: async ({ data }: { data: unknown }) => {
            store.auditRows.push(data);
            return { id: 'audit-1' };
          },
        },
      };
      return fn(tx);
    },
  },
}));

import {
  computeRunningBalance,
  snapshotTotalUnits,
  onHand,
  reconcilePhysicalCount,
  PoolSplitMismatchError,
  type BalanceComponents,
} from './running-balance';

const zeroPools = () => ({ program: 0, nonProgram: 0 });
const baseComponents = (): BalanceComponents => ({
  anchor: zeroPools(),
  verifiedInbound: zeroPools(),
  dropoffUnits: 0,
  stripped: zeroPools(),
  wholeUnitsSold: zeroPools(),
  landfilled: zeroPools(),
});

describe('computeRunningBalance — pool-aware algebra', () => {
  it('anchor + inbound + dropoffs − stripped − wholeUnitsSold − landfilled', () => {
    const r = computeRunningBalance({
      anchor: { program: 1000, nonProgram: 200 },
      verifiedInbound: { program: 150, nonProgram: 25 },
      dropoffUnits: 10, // program pool
      stripped: { program: 60, nonProgram: 5 },
      wholeUnitsSold: { program: 0, nonProgram: 12 },
      landfilled: { program: 3, nonProgram: 2 },
    });
    // program:    1000 + 150 + 10 − 60 − 0 − 3   = 1097
    // nonProgram:  200 +  25      −  5 − 12 − 2   =  206
    expect(r.program.toString()).toBe('1097');
    expect(r.nonProgram.toString()).toBe('206');
    expect(r.total.toString()).toBe('1303');
  });

  it("Rick's 150 program + 25 non-program stripping-day worked example", () => {
    // A 175-unit day with 150 program on the floor: MRC is billed only the 150.
    // Starting flat (no anchor, no prior flow), the stripped units leave the pools.
    const r = computeRunningBalance({
      ...baseComponents(),
      anchor: { program: 200, nonProgram: 40 },
      stripped: { program: 150, nonProgram: 25 },
    });
    expect(r.program.toString()).toBe('50'); // 200 − 150
    expect(r.nonProgram.toString()).toBe('15'); // 40 − 25
    expect(r.total.toString()).toBe('65');
  });

  it('program + nonProgram === total for arbitrary component sets (property style)', () => {
    for (let seed = 0; seed < 60; seed++) {
      const c: BalanceComponents = {
        anchor: { program: (seed * 7) % 500, nonProgram: (seed * 3) % 120 },
        verifiedInbound: { program: (seed * 11) % 90, nonProgram: (seed * 5) % 40 },
        dropoffUnits: (seed * 2) % 15,
        stripped: { program: (seed * 4) % 70, nonProgram: (seed * 6) % 20 },
        wholeUnitsSold: { program: seed % 5, nonProgram: (seed * 9) % 25 },
        landfilled: { program: seed % 3, nonProgram: seed % 4 },
      };
      const r = computeRunningBalance(c);
      expect(r.program.plus(r.nonProgram).equals(r.total)).toBe(true);
    }
  });

  it('handles Decimal(7,1) half-unit stripped quantities without float drift', () => {
    const r = computeRunningBalance({
      ...baseComponents(),
      anchor: { program: 100, nonProgram: 0 },
      stripped: { program: D('33.3'), nonProgram: D('0.0') },
    });
    // 100 − 33.3 = 66.7 exactly (Decimal, not 66.70000000000001)
    expect(r.program.toString()).toBe('66.7');
    expect(r.total.toString()).toBe('66.7');
  });

  it('baled/shredded outbound_materials are absent from the component set (never subtract)', () => {
    // The type itself has no weight-based-outbound field — only renovation
    // wholeUnitsSold subtracts. This test documents the invariant.
    const r = computeRunningBalance({
      ...baseComponents(),
      anchor: { program: 50, nonProgram: 0 },
    });
    expect(r.total.toString()).toBe('50');
  });

  it('accepts Decimal, number, and string inputs interchangeably', () => {
    const r = computeRunningBalance({
      ...baseComponents(),
      anchor: { program: '10', nonProgram: D(5) },
      verifiedInbound: { program: 5, nonProgram: 0 },
    });
    expect(r.total.toString()).toBe('20');
  });
});

describe('snapshotTotalUnits', () => {
  it('sums CA indoor+in_processing (no outdoor — ADR-0037 addendum)', () => {
    expect(
      snapshotTotalUnits({
        units_indoor: 4000,
        units_total: null,
        units_in_processing: 62,
      }),
    ).toBe(4062);
  });
  it('sums OR total+in_processing', () => {
    expect(
      snapshotTotalUnits({
        units_indoor: null,
        units_total: 5000,
        units_in_processing: 40,
      }),
    ).toBe(5040);
  });
});

describe('onHand — DB adapter', () => {
  beforeEach(() => {
    store.anchor = {
      snapshot_at: new Date('2026-06-30T00:00:00Z'),
      units_indoor: 4000,
      units_total: null,
      units_in_processing: 62,
    };
    store.inbound = { program_unit_count: 150, non_program_unit_count: 25 };
    store.dropoffs = { units: 10 };
    store.stripped = { stripped_program: D('60.0'), stripped_non_program: D('5.0') };
    store.wholeUnitsSold = { program_units: 0, non_program_units: 12 };
    store.landfilled = { program_units: 3, non_program_units: 2 };
  });

  it('composes the anchor (4062, all program) with pooled flow since it', async () => {
    const r = await onHand('site-woodland', new Date('2026-07-03T00:00:00Z'));
    // program:    4062 + 150 + 10 − 60 − 0 − 3 = 4159
    // nonProgram:    0 +  25      −  5 − 12 − 2 =    6
    expect(r.program.toString()).toBe('4159');
    expect(r.nonProgram.toString()).toBe('6');
    expect(r.total.toString()).toBe('4165');
  });

  it('does NOT subtract saved_units — live floor keeps saved units on it (rollup §5.2)', async () => {
    // Rick 2026-07-19: saved units are NOT removed from inventory until a store
    // transfer. A large `saved_units` in the daily closes must leave the live on-hand
    // balance identical to the baseline (which had no saved units) — the pre-Rick
    // model subtracted it from the non-program pool (would give nonProgram 6 − 40 = −34).
    store.stripped = {
      stripped_program: D('60.0'),
      stripped_non_program: D('5.0'),
      saved_units: D('40.0'),
    };
    const r = await onHand('site-woodland', new Date('2026-07-03T00:00:00Z'));
    expect(r.program.toString()).toBe('4159'); // unchanged
    expect(r.nonProgram.toString()).toBe('6'); // saved NOT subtracted (would be −34)
    expect(r.total.toString()).toBe('4165');
  });

  it('coalesces null aggregate sums to zero (no rows since anchor)', async () => {
    store.inbound = { program_unit_count: null, non_program_unit_count: null };
    store.dropoffs = { units: null };
    store.stripped = { stripped_program: null, stripped_non_program: null };
    store.wholeUnitsSold = { program_units: null, non_program_units: null };
    store.landfilled = { program_units: null, non_program_units: null };
    const r = await onHand('site-woodland', new Date('2026-07-03T00:00:00Z'));
    expect(r.total.toString()).toBe('4062');
  });
});

describe('reconcilePhysicalCount — writes anchor + audit, records delta', () => {
  beforeEach(() => {
    store.createdSnapshots.length = 0;
    store.auditRows.length = 0;
    store.anchor = {
      snapshot_at: new Date('2026-06-30T00:00:00Z'),
      units_indoor: 4000,
      units_total: null,
      units_in_processing: 0,
    };
    // No flow since anchor → computed total 4000.
    store.inbound = { program_unit_count: 0, non_program_unit_count: 0 };
    store.dropoffs = { units: 0 };
    store.stripped = { stripped_program: D(0), stripped_non_program: D(0) };
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 0, non_program_units: 0 };
  });

  it('records reconciled_delta = physical − computed and an audit row in one tx', async () => {
    const res = await reconcilePhysicalCount({
      siteId: 'site-woodland',
      countedAt: new Date('2026-07-03T00:00:00Z'),
      physical: { units_indoor: 3990, units_in_processing: 0 },
      actorUserId: 'user-bill',
    });
    expect(res.computedTotal.toString()).toBe('4000');
    expect(res.physicalTotal).toBe(3990);
    expect(res.reconciledDelta).toBe(-10);
    expect(store.createdSnapshots).toHaveLength(1);
    expect(store.auditRows).toHaveLength(1);
    const snap = store.createdSnapshots[0] as { snapshot_kind: string; reconciled_delta: number };
    expect(snap.snapshot_kind).toBe('physical');
    expect(snap.reconciled_delta).toBe(-10);
  });

  // ADR-0037 addendum (2026-07-22) — outdoor removed from Vision. A CA physical
  // count is indoor + in-processing only, and the persisted anchor carries no
  // outdoor field at all.
  it('accepts a CA physical count of indoor + in_processing and totals them', async () => {
    const res = await reconcilePhysicalCount({
      siteId: 'site-woodland',
      countedAt: new Date('2026-07-03T00:00:00Z'),
      physical: { units_indoor: 3900, units_in_processing: 77 },
      actorUserId: 'user-bill',
    });
    expect(res.physicalTotal).toBe(3977);
    expect(res.reconciledDelta).toBe(-23);
    const snap = store.createdSnapshots[0] as Record<string, unknown>;
    expect(snap['units_indoor']).toBe(3900);
    expect(snap['units_in_processing']).toBe(77);
    expect('units_outdoor' in snap).toBe(false);
  });
});

// ── ADR-0037 §3 pool split (handoff §1.4) ────────────────────────────────
describe('reconcilePhysicalCount — measured pool split validation', () => {
  beforeEach(() => {
    store.createdSnapshots.length = 0;
    store.auditRows.length = 0;
    store.anchor = {
      snapshot_at: new Date('2026-06-30T00:00:00Z'),
      units_total: 4000,
      units_indoor: null,
      units_in_processing: 0,
    };
    store.inbound = { program_unit_count: 0, non_program_unit_count: 0 };
    store.dropoffs = { units: 0 };
    store.stripped = { stripped_program: D(0), stripped_non_program: D(0) };
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 0, non_program_units: 0 };
  });

  it('measured: program + non-program === physical total persists the split', async () => {
    const res = await reconcilePhysicalCount({
      siteId: 'site-eugene',
      countedAt: new Date('2026-07-08T00:00:00Z'),
      physical: { units_total: 100, units_in_processing: 0 },
      programUnits: 60,
      nonProgramUnits: 40,
      poolAttribution: 'measured',
      actorUserId: 'user-bill',
    });
    expect(res.physicalTotal).toBe(100);
    const snap = store.createdSnapshots[0] as {
      program_units: number | null;
      non_program_units: number | null;
      pool_attribution: string;
    };
    expect(snap.program_units).toBe(60);
    expect(snap.non_program_units).toBe(40);
    expect(snap.pool_attribution).toBe('measured');
    // Pool fields land in the append-only audit `after` payload too.
    const audit = store.auditRows[0] as {
      after: { program_units: number | null; pool_attribution: string };
    };
    expect(audit.after.program_units).toBe(60);
    expect(audit.after.pool_attribution).toBe('measured');
  });

  it('measured: program + non-program !== physical total throws PoolSplitMismatchError (nothing persisted)', async () => {
    await expect(
      reconcilePhysicalCount({
        siteId: 'site-eugene',
        countedAt: new Date('2026-07-08T00:00:00Z'),
        physical: { units_total: 100, units_in_processing: 0 },
        programUnits: 60,
        nonProgramUnits: 30, // 90 ≠ 100
        poolAttribution: 'measured',
        actorUserId: 'user-bill',
      }),
    ).rejects.toBeInstanceOf(PoolSplitMismatchError);
    // Refused pre-transaction: no snapshot, no audit row.
    expect(store.createdSnapshots).toHaveLength(0);
    expect(store.auditRows).toHaveLength(0);
  });

  it('measured error carries a 422 status and pool_mismatch reason', async () => {
    const err: unknown = await reconcilePhysicalCount({
      siteId: 'site-eugene',
      countedAt: new Date('2026-07-08T00:00:00Z'),
      physical: { units_total: 100, units_in_processing: 0 },
      programUnits: 10,
      nonProgramUnits: 10,
      poolAttribution: 'measured',
      actorUserId: 'user-bill',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoolSplitMismatchError);
    const pe = err as PoolSplitMismatchError;
    expect(pe.status).toBe(422);
    expect(pe.reason).toBe('pool_mismatch');
  });
});

describe('onHand — anchor pool attribution (ADR-0037 §3)', () => {
  beforeEach(() => {
    // No flow since the anchor → the anchor's pools ARE the balance.
    store.inbound = { program_unit_count: 0, non_program_unit_count: 0 };
    store.dropoffs = { units: 0 };
    store.stripped = { stripped_program: D(0), stripped_non_program: D(0) };
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 0, non_program_units: 0 };
  });

  it('measured anchor uses the entered program/non-program split as the anchor pool', async () => {
    store.anchor = {
      snapshot_at: new Date('2026-07-01T00:00:00Z'),
      units_total: 1000,
      units_indoor: null,
      units_in_processing: 0,
      program_units: D(700),
      non_program_units: D(300),
      pool_attribution: 'measured',
    };
    const r = await onHand('site-eugene', new Date('2026-07-08T00:00:00Z'));
    expect(r.program.toString()).toBe('700');
    expect(r.nonProgram.toString()).toBe('300');
    expect(r.total.toString()).toBe('1000');
    expect(r.anchorPool).toBe('measured');
  });

  it('legacy anchor attributes the whole anchor to the program pool, non-program = 0', async () => {
    store.anchor = {
      snapshot_at: new Date('2026-07-01T00:00:00Z'),
      units_total: 1000,
      units_indoor: null,
      units_in_processing: 0,
      program_units: null,
      non_program_units: null,
      pool_attribution: 'legacy',
    };
    const r = await onHand('site-eugene', new Date('2026-07-08T00:00:00Z'));
    expect(r.program.toString()).toBe('1000');
    expect(r.nonProgram.toString()).toBe('0');
    expect(r.anchorPool).toBe('legacy');
  });

  it('measured attribution but null pool fields falls back to legacy (whole → program)', async () => {
    store.anchor = {
      snapshot_at: new Date('2026-07-01T00:00:00Z'),
      units_total: 1000,
      units_indoor: null,
      units_in_processing: 0,
      program_units: null,
      non_program_units: null,
      pool_attribution: 'measured',
    };
    const r = await onHand('site-eugene', new Date('2026-07-08T00:00:00Z'));
    expect(r.program.toString()).toBe('1000');
    expect(r.nonProgram.toString()).toBe('0');
    expect(r.anchorPool).toBe('legacy');
  });
});
