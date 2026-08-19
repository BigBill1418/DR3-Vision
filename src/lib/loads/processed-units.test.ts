// ADR-0037 D5 (Addendum B4) — processed_units_daily service tests. The post-close
// edit BLOCK, the close-writes-audit path, and the derived close-confirmation
// (whole-units-sold + landfilled) are the load-bearing behaviors.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

interface Row {
  id: string;
  site_id: string;
  production_date: Date;
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  saved_units: Prisma.Decimal | null;
  material_ticket_number: string | null;
  employees_count: number | null;
  processors_count: number | null;
  pocketcoil_estimate: number | null;
  source: string;
  entered_by: string | null;
  closed_at: Date | null;
  notes: string | null;
}
const store = {
  rows: [] as Row[],
  audits: [] as unknown[],
  // Derived-outflow aggregates (renovation outbound + landfilled). Also serve the
  // close-path onHand() wholeUnitsSold/landfilled aggregates (same shape).
  reno: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  land: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  // Per-date outflow (drives both the date-aware single aggregate and the batched
  // groupBy) so list==per-day-derive equivalence is assertable. Keyed by day epoch.
  renoByDate: new Map<number, { program_units: number; non_program_units: number }>(),
  landByDate: new Map<number, { program_units: number; non_program_units: number }>(),
  // onHand() inputs for the close negative-balance guard.
  anchor: null as null | {
    snapshot_at: Date;
    units_indoor: number | null;
    units_total: number | null;
    units_in_processing: number;
  },
  inboundAgg: { program_unit_count: 0, non_program_unit_count: 0 } as Record<string, number | null>,
  // handoff #270 §1 — `onHand` GROUPS drop-offs by kind so an untaught kind can be
  // refused rather than silently summed. Mirrors the real `groupBy` return shape.
  dropoffAgg: [] as Array<{ kind: string; _sum: { units: number | null } }>,
  strippedAgg: { stripped_program: 0, stripped_non_program: 0 } as Record<string, number | null>,
};

vi.mock('@/lib/prisma', () => {
  const model = {
    findUnique: async ({
      where,
    }: {
      where: { id?: string; site_id_production_date?: { site_id: string; production_date: Date } };
    }) => {
      if (where.id) return store.rows.find((r) => r.id === where.id) ?? null;
      const k = where.site_id_production_date!;
      return (
        store.rows.find(
          (r) =>
            r.site_id === k.site_id && r.production_date.getTime() === k.production_date.getTime(),
        ) ?? null
      );
    },
    findMany: async () => store.rows,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { site_id_production_date: { site_id: string; production_date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const k = where.site_id_production_date;
      const found = store.rows.find(
        (r) =>
          r.site_id === k.site_id && r.production_date.getTime() === k.production_date.getTime(),
      );
      if (found) {
        Object.assign(found, update);
        return found;
      }
      const row = {
        id: `p${store.rows.length + 1}`,
        closed_at: null,
        notes: null,
        ...create,
      } as Row;
      store.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = store.rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
    // onHand()'s stripped aggregate (close negative-balance guard).
    aggregate: async () => ({ _sum: store.strippedAgg }),
  };
  return {
    prisma: {
      processedUnitsDaily: model,
      outboundMaterial: {
        // Exact-date where (deriveDailyOutflow) reads per-date data, falling back to
        // the global store.reno; a range where (onHand) uses the global store.reno.
        aggregate: async (args?: { where?: { ship_date?: Date | Record<string, unknown> } }) => {
          const sd = args?.where?.ship_date;
          if (sd instanceof Date) return { _sum: store.renoByDate.get(sd.getTime()) ?? store.reno };
          return { _sum: store.reno };
        },
        // Batched list path (deriveDailyOutflowBatch).
        groupBy: async (args?: { where?: { ship_date?: { in?: Date[] } } }) => {
          const inDays = args?.where?.ship_date?.in ?? [];
          return inDays
            .filter((d) => store.renoByDate.has(d.getTime()))
            .map((d) => ({ ship_date: d, _sum: store.renoByDate.get(d.getTime())! }));
        },
      },
      landfilledUnit: {
        aggregate: async (args?: {
          where?: { disposal_date?: Date | Record<string, unknown> };
        }) => {
          const dd = args?.where?.disposal_date;
          if (dd instanceof Date) return { _sum: store.landByDate.get(dd.getTime()) ?? store.land };
          return { _sum: store.land };
        },
        groupBy: async (args?: { where?: { disposal_date?: { in?: Date[] } } }) => {
          const inDays = args?.where?.disposal_date?.in ?? [];
          return inDays
            .filter((d) => store.landByDate.has(d.getTime()))
            .map((d) => ({ disposal_date: d, _sum: store.landByDate.get(d.getTime())! }));
        },
      },
      // onHand() inputs (close negative-balance guard).
      siteInventorySnapshot: { findFirst: async () => store.anchor },
      inboundLoad: { aggregate: async () => ({ _sum: store.inboundAgg }) },
      consumerDropoff: { groupBy: async () => store.dropoffAgg },
      auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          processedUnitsDaily: model,
          auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
        }),
    },
  };
});

import {
  upsertProcessedUnits,
  closeProcessedUnitsDay,
  listProcessedUnits,
  deriveDailyOutflow,
  ProcessedUnitsError,
} from './processed-units';

const SITE = 'S1';
const DAY = new Date('2026-07-03T00:00:00Z');

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
  store.reno = { program_units: 0, non_program_units: 0 };
  store.land = { program_units: 0, non_program_units: 0 };
  store.renoByDate.clear();
  store.landByDate.clear();
  store.anchor = null;
  store.inboundAgg = { program_unit_count: 0, non_program_unit_count: 0 };
  store.dropoffAgg = [];
  store.strippedAgg = { stripped_program: 0, stripped_non_program: 0 };
});

describe('upsertProcessedUnits', () => {
  it('creates a row with stripped split + derived total, writes an audit', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 150,
      strippedNonProgram: 25,
      actorUserId: 'U1',
    });
    expect(v.strippedProgram).toBe('150');
    expect(v.strippedNonProgram).toBe('25');
    expect(v.totalStripped).toBe('175');
    expect(store.audits).toHaveLength(1);
  });

  it('persists the daily-close metadata + saved units (saved excluded from math)', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 100,
      strippedNonProgram: 0,
      savedUnits: 12.5,
      materialTicketNumber: 'M-004562',
      employeesCount: 6,
      processorsCount: 4,
      pocketcoilEstimate: 30,
      actorUserId: 'U1',
    });
    expect(v.savedUnits).toBe('12.5');
    expect(v.materialTicketNumber).toBe('M-004562');
    expect(v.employeesCount).toBe(6);
    expect(v.processorsCount).toBe(4);
    expect(v.pocketcoilEstimate).toBe(30);
  });

  it('surfaces the DERIVED whole-units-sold + landfilled for the day (never entered)', async () => {
    store.reno = { program_units: 8, non_program_units: 2 };
    store.land = { program_units: 3, non_program_units: 0 };
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 100,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    expect(v.derived.wholeUnitsSold.total).toBe(10);
    expect(v.derived.landfilled.total).toBe(3);
  });

  it('updates the same day in place before close', async () => {
    await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 150,
      strippedNonProgram: 25,
      actorUserId: 'U1',
    });
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 160,
      strippedNonProgram: 15,
      actorUserId: 'U1',
    });
    expect(v.strippedProgram).toBe('160');
    expect(store.rows).toHaveLength(1);
  });

  it('BLOCKS an edit after the day is closed (directs to amendment path)', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 150,
      strippedNonProgram: 25,
      actorUserId: 'U1',
    });
    await closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' });
    try {
      await upsertProcessedUnits({
        siteId: SITE,
        productionDate: DAY,
        strippedProgram: 999,
        strippedNonProgram: 0,
        actorUserId: 'U1',
      });
      expect.unreachable('should have blocked');
    } catch (e) {
      expect(e).toBeInstanceOf(ProcessedUnitsError);
      expect((e as ProcessedUnitsError).reason).toBe('closed');
      expect((e as ProcessedUnitsError).status).toBe(409);
    }
  });

  it('rejects invalid quantities', async () => {
    await expect(
      upsertProcessedUnits({
        siteId: SITE,
        productionDate: DAY,
        strippedProgram: -1,
        strippedNonProgram: 0,
        actorUserId: 'U1',
      }),
    ).rejects.toBeInstanceOf(ProcessedUnitsError);
  });
});

describe('closeProcessedUnitsDay', () => {
  it('stamps closed_at + writes an audit row, then refuses a second close', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 150,
      strippedNonProgram: 25,
      actorUserId: 'U1',
    });
    const closed = await closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' });
    expect(closed.closedAt).not.toBeNull();
    expect(store.audits.length).toBeGreaterThanOrEqual(2);
    await expect(
      closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(ProcessedUnitsError);
  });

  it('404s a row at another site', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 1,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    await expect(
      closeProcessedUnitsDay({ id: v.id, siteId: 'OTHER', actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(ProcessedUnitsError);
  });
});

describe('closeProcessedUnitsDay — negative-balance guard (D6, finding 10)', () => {
  it('REFUSES (422 negative_balance) a close that drives the PROGRAM pool negative, no ack', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 200,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    // No anchor, no inbound → 200 stripped drives program to −200.
    store.strippedAgg = { stripped_program: 200, stripped_non_program: 0 };
    try {
      await closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' });
      expect.unreachable('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ProcessedUnitsError);
      expect((e as ProcessedUnitsError).reason).toBe('negative_balance');
      expect((e as ProcessedUnitsError).status).toBe(422);
      expect((e as ProcessedUnitsError).message).toContain('program=-200');
    }
    // Never stamped closed.
    expect(store.rows[0]?.closed_at ?? null).toBeNull();
  });

  it('detects a negative NON-PROGRAM pool as well', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 0,
      strippedNonProgram: 50,
      actorUserId: 'U1',
    });
    store.strippedAgg = { stripped_program: 0, stripped_non_program: 50 };
    await expect(
      closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(ProcessedUnitsError);
    expect(store.rows[0]?.closed_at ?? null).toBeNull();
  });

  it('CLOSES a negative day when acknowledgeNegative is set, and audits the acknowledgment + numbers', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 200,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    store.strippedAgg = { stripped_program: 200, stripped_non_program: 0 };
    const closed = await closeProcessedUnitsDay({
      id: v.id,
      siteId: SITE,
      actorUserId: 'U1',
      acknowledgeNegative: true,
    });
    expect(closed.closedAt).not.toBeNull();
    const closeAudit = store.audits.at(-1) as { after: Record<string, unknown> };
    expect(closeAudit.after['acknowledged_negative']).toBe(true);
    expect(closeAudit.after['balance_program']).toBe('-200');
  });

  it('CLOSES normally (no ack, no acknowledgment audit) when the balance stays non-negative', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 200,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    // A 500-unit physical anchor absorbs the 200 stripped → +300, non-negative.
    store.anchor = {
      snapshot_at: new Date('2026-07-01T00:00:00Z'),
      units_indoor: 500,
      units_total: null,
      units_in_processing: 0,
    };
    store.strippedAgg = { stripped_program: 200, stripped_non_program: 0 };
    const closed = await closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' });
    expect(closed.closedAt).not.toBeNull();
    const closeAudit = store.audits.at(-1) as { after: Record<string, unknown> };
    expect(closeAudit.after['acknowledged_negative']).toBeUndefined();
  });
});

describe('listProcessedUnits', () => {
  it('returns rows for the site', async () => {
    await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 150,
      strippedNonProgram: 25,
      actorUserId: 'U1',
    });
    const rows = await listProcessedUnits(SITE);
    expect(rows).toHaveLength(1);
  });

  it('batched list-derived outflow EQUALS the per-day deriveDailyOutflow for every row (finding 7)', async () => {
    const d1 = new Date('2026-07-01T00:00:00Z');
    const d2 = new Date('2026-07-02T00:00:00Z');
    const d3 = new Date('2026-07-03T00:00:00Z');
    await upsertProcessedUnits({
      siteId: SITE,
      productionDate: d1,
      strippedProgram: 10,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    await upsertProcessedUnits({
      siteId: SITE,
      productionDate: d2,
      strippedProgram: 20,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    await upsertProcessedUnits({
      siteId: SITE,
      productionDate: d3,
      strippedProgram: 30,
      strippedNonProgram: 0,
      actorUserId: 'U1',
    });
    // Distinct per-date outflow; d2 has NONE (must map to ZERO_OUTFLOW, exactly as the
    // single-day path returns for a day with no rows).
    store.renoByDate.set(d1.getTime(), { program_units: 5, non_program_units: 1 });
    store.landByDate.set(d1.getTime(), { program_units: 2, non_program_units: 0 });
    store.renoByDate.set(d3.getTime(), { program_units: 7, non_program_units: 3 });

    const rows = await listProcessedUnits(SITE);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const single = await deriveDailyOutflow(SITE, row.productionDate);
      expect(row.derived).toEqual(single);
    }
    const r1 = rows.find((r) => r.productionDate.getTime() === d1.getTime())!;
    expect(r1.derived.wholeUnitsSold.total).toBe(6);
    expect(r1.derived.landfilled.total).toBe(2);
    const r2 = rows.find((r) => r.productionDate.getTime() === d2.getTime())!;
    expect(r2.derived.wholeUnitsSold.total).toBe(0);
    expect(r2.derived.landfilled.total).toBe(0);
  });
});
