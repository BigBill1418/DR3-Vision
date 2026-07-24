// ADR-0037 Phase 3 (§3.2b) — bulk daily inbound service tests.
//
// Load-bearing behaviors: the program / non-program split must sum to the day total
// (it is the billable-pool statement), the row must carry the `paper_bulk`
// provenance + a balance-admissible status/date, and re-entering a day must AMEND
// that day rather than double-count the inflow.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordValidationError } from '@/lib/loads/record-guards';
import { pacificMidnightInstantOfDayISO } from '@/lib/time';

interface Row {
  id: string;
  site_id: string;
  load_source_type: string;
  count_mode: string | null;
  status: string;
  arrived_at: Date | null;
  submitted_at: Date | null;
  submitted_by_id: string | null;
  total_units: number | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  slip_number: string | null;
}

interface Audit {
  action: string;
  table_name: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}
const store = { rows: [] as Row[], audits: [] as Audit[] };

vi.mock('@/lib/prisma', () => {
  const inboundLoad = {
    findFirst: async ({
      where,
    }: {
      where: { site_id: string; load_source_type: string; arrived_at: Date };
    }) => {
      // Prisma returns a detached snapshot, not the live row — copy so a later
      // in-transaction update cannot retroactively mutate the `before` audit values.
      const hit = store.rows.find(
        (r) =>
          r.site_id === where.site_id &&
          r.load_source_type === where.load_source_type &&
          r.arrived_at?.getTime() === where.arrived_at.getTime(),
      );
      return hit ? { ...hit } : null;
    },
    findMany: async ({ where }: { where: { site_id: string; load_source_type: string } }) =>
      store.rows.filter(
        (r) => r.site_id === where.site_id && r.load_source_type === where.load_source_type,
      ),
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

const { upsertBulkInboundDay, listBulkInboundDays, PAPER_BULK_SOURCE_TYPE } = await import(
  './bulk-inbound'
);

const SITE = 'site-woodland';
const ACTOR = 'user-morena';
const DAY = new Date('2026-07-20T00:00:00Z');

beforeEach(() => {
  store.rows = [];
  store.audits = [];
});

describe('upsertBulkInboundDay — program / non-program split', () => {
  it('accepts a split that sums to the day total', async () => {
    const view = await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 180,
      programUnits: 150,
      nonProgramUnits: 30,
      actorUserId: ACTOR,
    });
    expect(view.totalUnits).toBe(180);
    expect(view.programUnits).toBe(150);
    expect(view.nonProgramUnits).toBe(30);
  });

  it('refuses a split that does not sum to the day total', async () => {
    await expect(
      upsertBulkInboundDay({
        siteId: SITE,
        inboundDate: DAY,
        totalUnits: 180,
        programUnits: 150,
        nonProgramUnits: 25,
        actorUserId: ACTOR,
      }),
    ).rejects.toBeInstanceOf(RecordValidationError);
    expect(store.rows).toHaveLength(0);
  });

  it('refuses a zero-unit day and a fractional total', async () => {
    const base = { siteId: SITE, inboundDate: DAY, actorUserId: ACTOR };
    await expect(
      upsertBulkInboundDay({ ...base, totalUnits: 0, programUnits: 0, nonProgramUnits: 0 }),
    ).rejects.toBeInstanceOf(RecordValidationError);
    await expect(
      upsertBulkInboundDay({ ...base, totalUnits: 10.5, programUnits: 10.5, nonProgramUnits: 0 }),
    ).rejects.toBeInstanceOf(RecordValidationError);
    expect(store.rows).toHaveLength(0);
  });
});

describe('upsertBulkInboundDay — source attribution', () => {
  it('tags the row paper_bulk with a total count mode and no dock provenance', async () => {
    await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 40,
      programUnits: 40,
      nonProgramUnits: 0,
      slipNumber: 'DL-2026-07-20',
      actorUserId: ACTOR,
    });
    const row = store.rows[0]!;
    expect(row.load_source_type).toBe(PAPER_BULK_SOURCE_TYPE);
    expect(PAPER_BULK_SOURCE_TYPE).toBe('paper_bulk');
    expect(row.count_mode).toBe('total');
    expect(row.slip_number).toBe('DL-2026-07-20');
    expect(row.submitted_by_id).toBe(ACTOR);
  });

  it('writes a balance-admissible row: verified status, arrived_at at PACIFIC midnight', async () => {
    await upsertBulkInboundDay({
      siteId: SITE,
      // A mid-day timestamp must still key to the business day.
      inboundDate: new Date('2026-07-20T18:42:07Z'),
      totalUnits: 12,
      programUnits: 9,
      nonProgramUnits: 3,
      actorUserId: ACTOR,
    });
    const row = store.rows[0]!;
    expect(row.status).toBe('verified');
    // Pacific midnight of 2026-07-20 (PDT, UTC-7) = 07:00Z — the same instant the D1
    // promotion window keys on, so the row can never fall a Pacific day out of its month.
    expect(row.arrived_at?.toISOString()).toBe('2026-07-20T07:00:00.000Z');
  });

  it('a first-of-month row lands INSIDE that month`s Pacific promotion window (finding 3)', async () => {
    // A UTC-midnight July-1 row (2026-07-01T00:00:00Z = 2026-06-30 17:00 PDT) sits below
    // the July promotion window`s lower bound and escapes the conflict-refusal → double
    // count. The Pacific-midnight instant is exactly that lower bound, so it is caught.
    await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: new Date('2026-07-01T00:00:00Z'),
      totalUnits: 200,
      programUnits: 200,
      nonProgramUnits: 0,
      actorUserId: ACTOR,
    });
    const arrivedAt = store.rows[0]!.arrived_at!;
    const julyWindowLowerBound = pacificMidnightInstantOfDayISO('2026-07-01');
    expect(arrivedAt.getTime()).toBe(julyWindowLowerBound.getTime());
    // Explicitly NOT the old UTC-midnight value that escaped the window.
    expect(arrivedAt.toISOString()).not.toBe('2026-07-01T00:00:00.000Z');
    // And it is >= the window`s inclusive lower bound (detectConflicts would match it).
    expect(arrivedAt.getTime()).toBeGreaterThanOrEqual(julyWindowLowerBound.getTime());
  });

  it('audits the insert with the provenance and unit counts', async () => {
    await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 12,
      programUnits: 9,
      nonProgramUnits: 3,
      actorUserId: ACTOR,
    });
    expect(store.audits).toHaveLength(1);
    const audit = store.audits[0]!;
    expect(audit.action).toBe('insert');
    expect(audit.table_name).toBe('inbound_loads');
    expect(audit.after).toMatchObject({
      load_source_type: 'paper_bulk',
      arrived_at: '2026-07-20',
      total_units: 12,
      program_unit_count: 9,
      non_program_unit_count: 3,
    });
  });
});

describe('upsertBulkInboundDay — one row per site per day', () => {
  it('amends the existing day rather than adding a second row', async () => {
    await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 100,
      programUnits: 100,
      nonProgramUnits: 0,
      actorUserId: ACTOR,
    });
    const amended = await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 130,
      programUnits: 110,
      nonProgramUnits: 20,
      actorUserId: ACTOR,
    });
    expect(store.rows).toHaveLength(1);
    expect(amended.totalUnits).toBe(130);
    expect(store.audits.map((a) => a.action)).toEqual(['insert', 'update']);
    expect(store.audits[1]!.before).toMatchObject({ total_units: 100, program_unit_count: 100 });
  });

  it('keeps separate days separate', async () => {
    const base = { siteId: SITE, actorUserId: ACTOR, programUnits: 5, nonProgramUnits: 0 };
    await upsertBulkInboundDay({ ...base, inboundDate: DAY, totalUnits: 5 });
    await upsertBulkInboundDay({
      ...base,
      inboundDate: new Date('2026-07-21T00:00:00Z'),
      totalUnits: 5,
    });
    expect(store.rows).toHaveLength(2);
    expect(await listBulkInboundDays(SITE)).toHaveLength(2);
  });
});

describe('upsertBulkInboundDay — ADR-0059 confirmation supersedes provisional', () => {
  it('DELETES the provisional mymrc_haul row for the day and installs the paper_bulk row (delete audited, one aggregate row remains)', async () => {
    const day = pacificMidnightInstantOfDayISO('2026-07-20');
    // A provisional bridge aggregate already owns this (site, day) slot.
    store.rows.push({
      id: 'mymrc-1',
      site_id: SITE,
      load_source_type: 'mymrc_haul',
      count_mode: 'total',
      status: 'verified',
      arrived_at: day,
      submitted_at: null,
      submitted_by_id: null,
      total_units: 561,
      program_unit_count: 561,
      non_program_unit_count: 0,
      slip_number: null,
    });

    const view = await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 180,
      programUnits: 150,
      nonProgramUnits: 30,
      actorUserId: ACTOR,
    });

    // The provisional row is gone; exactly one aggregate row remains — the paper_bulk one.
    expect(store.rows.some((r) => r.id === 'mymrc-1')).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.load_source_type).toBe('paper_bulk');
    expect(view.totalUnits).toBe(180);
    // The delete is audited (before the insert), then the insert.
    expect(store.audits.map((a) => a.action)).toEqual(['delete', 'insert']);
    expect(store.audits[0]).toMatchObject({
      action: 'delete',
      table_name: 'inbound_loads',
      before: { load_source_type: 'mymrc_haul', program_unit_count: 561 },
    });
  });

  it('amending a paper_bulk day writes no delete (no mymrc_haul row can coexist under the unique index)', async () => {
    await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 100,
      programUnits: 100,
      nonProgramUnits: 0,
      actorUserId: ACTOR,
    });
    await upsertBulkInboundDay({
      siteId: SITE,
      inboundDate: DAY,
      totalUnits: 120,
      programUnits: 120,
      nonProgramUnits: 0,
      actorUserId: ACTOR,
    });
    expect(store.audits.map((a) => a.action)).toEqual(['insert', 'update']); // no delete
    expect(store.rows).toHaveLength(1);
  });
});
