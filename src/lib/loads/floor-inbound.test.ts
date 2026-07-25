// ADR-0060 — iPad floor inbound-confirmation service tests.
//
// Load-bearing behaviors (the money path): the split invariant must sum; a confirm
// RETIRES the day's mymrc_haul provisional (audited delete) and installs exactly ONE
// ipad_floor aggregate; a re-confirm UPDATEs in place (absolute SET, no second row);
// a day with per-load dock captures is REFUSED (409 per_load_exists, no write, no audit
// — the ADR-0060 D5 aggregate-vs-per-load double-count guard); a day owned by the office
// paper_bulk is REFUSED (409 office_owned, precedence); an Eugene day with no provisional
// can be ENTERED from scratch; every write audits with the operator as actor.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordValidationError } from '@/lib/loads/record-guards';
import { pacificMidnightInstantOfDayISO } from '@/lib/time';

interface Row {
  id: string;
  site_id: string;
  load_source_type: string;
  count_mode: string | null;
  status: string | null;
  arrived_at: Date | null;
  submitted_at: Date | null;
  submitted_by_id: string | null;
  total_units: number | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  slip_number: string | null;
}
interface Audit {
  actor_user_id: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}
const store = { rows: [] as Row[], audits: [] as Audit[] };

type Where = {
  site_id?: string;
  status?: { in: string[] };
  load_source_type?: { in?: string[]; notIn?: string[] };
  arrived_at?: Date | { gte: Date; lt: Date };
};

vi.mock('@/lib/prisma', () => {
  const inboundLoad = {
    findFirst: async ({ where }: { where: Where }) => {
      const scoped = store.rows.filter((r) => r.site_id === where.site_id);
      // Per-load guard shape: status.in + load_source_type.notIn + arrived_at.{gte,lt}.
      if (
        where.status?.in &&
        where.load_source_type?.notIn &&
        where.arrived_at &&
        !(where.arrived_at instanceof Date)
      ) {
        const { gte, lt } = where.arrived_at;
        const hit = scoped.find(
          (r) =>
            where.status!.in.includes(r.status ?? '') &&
            !where.load_source_type!.notIn!.includes(r.load_source_type) &&
            r.arrived_at != null &&
            r.arrived_at.getTime() >= gte.getTime() &&
            r.arrived_at.getTime() < lt.getTime(),
        );
        return hit ? { id: hit.id } : null;
      }
      // Existing-aggregate shape: load_source_type.in + exact arrived_at.
      if (where.load_source_type?.in && where.arrived_at instanceof Date) {
        const at = where.arrived_at.getTime();
        const hit = scoped.find(
          (r) =>
            where.load_source_type!.in!.includes(r.load_source_type) &&
            r.arrived_at?.getTime() === at,
        );
        return hit ? { ...hit } : null;
      }
      return null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `l${store.rows.length + 1}`, ...data } as Row;
      store.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const i = store.rows.findIndex((r) => r.id === where.id);
      const [removed] = store.rows.splice(i, 1);
      return removed;
    },
  };
  const tx = {
    inboundLoad,
    auditLog: {
      create: async ({ data }: { data: Audit }) => {
        store.audits.push(data);
        return data;
      },
    },
  };
  return {
    prisma: {
      inboundLoad,
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

const { confirmFloorInboundDay, FloorInboundConflictError, FLOOR_SOURCE_TYPE } = await import(
  './floor-inbound'
);

const SITE = 'site-woodland';
const OP = 'user-operator';
const DAY = new Date('2026-07-20T00:00:00Z');
const DAY_INSTANT = pacificMidnightInstantOfDayISO('2026-07-20');

function provisional(over: Partial<Row> = {}): Row {
  return {
    id: 'mymrc-1',
    site_id: SITE,
    load_source_type: 'mymrc_haul',
    count_mode: 'total',
    status: 'verified',
    arrived_at: DAY_INSTANT,
    submitted_at: null,
    submitted_by_id: null,
    total_units: 561,
    program_unit_count: 561,
    non_program_unit_count: 0,
    slip_number: null,
    ...over,
  };
}

beforeEach(() => {
  store.rows = [];
  store.audits = [];
});

describe('confirmFloorInboundDay — split invariant', () => {
  it('refuses a split that does not sum to the total (422, no write)', async () => {
    await expect(
      confirmFloorInboundDay({
        siteId: SITE,
        inboundDate: DAY,
        totalUnits: 180,
        programUnits: 150,
        nonProgramUnits: 25,
        actorUserId: OP,
      }),
    ).rejects.toBeInstanceOf(RecordValidationError);
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });
});

describe('confirmFloorInboundDay — confirm retires the provisional', () => {
  it('DELETES the mymrc_haul provisional and installs exactly ONE ipad_floor row (delete + insert audited)', async () => {
    store.rows.push(provisional());
    const view = await confirmFloorInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 180,
      programUnits: 150,
      nonProgramUnits: 30,
      actorUserId: OP,
    });
    expect(store.rows.some((r) => r.id === 'mymrc-1')).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.load_source_type).toBe(FLOOR_SOURCE_TYPE);
    expect(store.rows[0]!.status).toBe('verified');
    expect(store.rows[0]!.count_mode).toBe('total');
    expect(store.rows[0]!.submitted_by_id).toBe(OP);
    expect(store.rows[0]!.arrived_at?.toISOString()).toBe('2026-07-20T07:00:00.000Z');
    expect(view.totalUnits).toBe(180);
    expect(store.audits.map((a) => a.action)).toEqual(['delete', 'insert']);
    expect(store.audits.every((a) => a.actor_user_id === OP)).toBe(true);
    expect(store.audits[0]).toMatchObject({
      action: 'delete',
      table_name: 'inbound_loads',
      before: { load_source_type: 'mymrc_haul', program_unit_count: 561 },
    });
  });

  it('carries a correction note into slip_number', async () => {
    store.rows.push(provisional());
    await confirmFloorInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 200,
      programUnits: 200,
      nonProgramUnits: 0,
      actorUserId: OP,
      correctionNote: 'recount after re-weigh',
    });
    expect(store.rows[0]!.slip_number).toBe('recount after re-weigh');
  });
});

describe('confirmFloorInboundDay — idempotent re-confirm', () => {
  it('UPDATEs the existing ipad_floor row in place (absolute SET, no second row, no delete)', async () => {
    // First confirm (from scratch).
    await confirmFloorInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 100,
      programUnits: 100,
      nonProgramUnits: 0,
      actorUserId: OP,
    });
    // Re-confirm with corrected counts.
    const view = await confirmFloorInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 130,
      programUnits: 110,
      nonProgramUnits: 20,
      actorUserId: OP,
    });
    expect(store.rows).toHaveLength(1);
    expect(view.totalUnits).toBe(130);
    expect(store.audits.map((a) => a.action)).toEqual(['insert', 'update']);
    expect(store.audits[1]!.before).toMatchObject({ total_units: 100, program_unit_count: 100 });
  });
});

describe('confirmFloorInboundDay — money-safety guards', () => {
  it('REFUSES a day that already has a verified per-load b2b_haul row (409 per_load_exists, no write)', async () => {
    store.rows.push({
      id: 'b2b-1',
      site_id: SITE,
      load_source_type: 'b2b_haul',
      count_mode: 'ledger',
      status: 'verified',
      // A dock capture mid-day, inside the Pacific day window.
      arrived_at: new Date('2026-07-20T18:00:00Z'),
      submitted_at: null,
      submitted_by_id: null,
      total_units: 40,
      program_unit_count: 40,
      non_program_unit_count: 0,
      slip_number: null,
    });
    const err = await confirmFloorInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 180,
      programUnits: 180,
      nonProgramUnits: 0,
      actorUserId: OP,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FloorInboundConflictError);
    expect(err.status).toBe(409);
    expect(err.reason).toBe('per_load_exists');
    // The b2b row is untouched; no aggregate written; no audit.
    expect(store.rows.map((r) => r.load_source_type)).toEqual(['b2b_haul']);
    expect(store.audits).toHaveLength(0);
  });

  it('REFUSES a day owned by an office paper_bulk row (409 office_owned, precedence, no write)', async () => {
    store.rows.push(provisional({ id: 'paper-1', load_source_type: 'paper_bulk', submitted_by_id: 'mgr' }));
    const err = await confirmFloorInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 180,
      programUnits: 180,
      nonProgramUnits: 0,
      actorUserId: OP,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FloorInboundConflictError);
    expect(err.reason).toBe('office_owned');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.load_source_type).toBe('paper_bulk');
    expect(store.audits).toHaveLength(0);
  });

  it('does NOT trip the per-load guard for a per-load row on a DIFFERENT Pacific day', async () => {
    store.rows.push({
      id: 'b2b-prev',
      site_id: SITE,
      load_source_type: 'b2b_haul',
      count_mode: 'ledger',
      status: 'verified',
      arrived_at: new Date('2026-07-19T18:00:00Z'), // the prior Pacific day
      submitted_at: null,
      submitted_by_id: null,
      total_units: 10,
      program_unit_count: 10,
      non_program_unit_count: 0,
      slip_number: null,
    });
    const view = await confirmFloorInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 50,
      programUnits: 50,
      nonProgramUnits: 0,
      actorUserId: OP,
    });
    expect(view.totalUnits).toBe(50);
    expect(store.rows.some((r) => r.load_source_type === FLOOR_SOURCE_TYPE)).toBe(true);
  });
});

describe('confirmFloorInboundDay — Eugene enter-from-scratch', () => {
  it('writes a fresh ipad_floor row when no aggregate and no provisional exist', async () => {
    const view = await confirmFloorInboundDay({
      siteId: 'site-eugene',
      inboundDate: DAY,
      totalUnits: 75,
      programUnits: 60,
      nonProgramUnits: 15,
      actorUserId: OP,
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.load_source_type).toBe(FLOOR_SOURCE_TYPE);
    expect(view.totalUnits).toBe(75);
    expect(store.audits.map((a) => a.action)).toEqual(['insert']);
    expect(store.audits[0]!.actor_user_id).toBe(OP);
  });
});
