// ADR-0079 — the manager's daily machine capture: validation, the Pacific-day
// rule, the prior-day refusal, audit + actor discipline, and soft-void.
//
// Real `Prisma.Decimal` throughout — run hours are a Decimal(5,2) in the database
// and a test that swaps in a float measures a type the product does not have.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const MACHINE = { id: 'eq-terex-1', display_name: 'Terex' };

interface Row {
  id: string;
  site_id: string;
  equipment_id: string;
  throughput_date: Date;
  units_processed: number;
  run_hours: Prisma.Decimal;
  notes: string | null;
  created_by: string | null;
  actor_label: string | null;
  voided_at: Date | null;
  voided_by: string | null;
  created_at: Date;
}

interface AuditRow {
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before?: unknown;
  after?: unknown;
}

interface CreateData {
  site_id: string;
  equipment_id: string;
  throughput_date: Date;
  units_processed: number;
  run_hours: Prisma.Decimal;
  notes?: string | null;
  created_by?: string | null;
  actor_label?: string | null;
}

interface UpdateData {
  units_processed?: number;
  run_hours?: Prisma.Decimal;
  notes?: string | null;
  voided_at?: Date;
  voided_by?: string | null;
}

interface FindFirstWhere {
  equipment_id: string;
  throughput_date: Date;
  voided_at: null;
}

interface FindManyWhere {
  site_id?: string;
  equipment_id?: string;
  voided_at?: null;
  throughput_date?: { gte: Date; lte: Date };
}

interface EquipmentWhere {
  site_id: string;
  category: string;
  is_active: boolean;
  merged_into_id: null;
  links: { some: Record<string, never> };
}

const store = {
  rows: [] as Row[],
  audits: [] as AuditRow[],
  machine: MACHINE as { id: string; display_name: string } | null,
  seq: 0,
};

/**
 * The (equipment_id, throughput_date) PARTIAL unique index, enforced in the mock
 * exactly as Postgres enforces it: it covers LIVE rows only (`voided_at IS NULL`),
 * so a voided row does not hold its day hostage.
 *
 * This mock deliberately RAISES rather than silently permitting a duplicate,
 * because a mock that quietly allows what the database refuses would let the
 * uniqueness test pass while measuring nothing.
 */
function assertPartialUnique(equipmentId: string, day: Date, ignoreId?: string) {
  const clash = store.rows.find(
    (r) =>
      r.id !== ignoreId &&
      r.equipment_id === equipmentId &&
      r.throughput_date.getTime() === day.getTime() &&
      r.voided_at === null,
  );
  if (clash) {
    throw Object.assign(
      new Error(
        'Unique constraint failed on the fields: (`equipment_id`,`throughput_date`) [equipment_daily_throughput_machine_day_key]',
      ),
      { code: 'P2002' },
    );
  }
}

vi.mock('@/lib/prisma', () => {
  const tx = {
    equipmentDailyThroughput: {
      create: async ({ data }: { data: CreateData }) => {
        const day = data.throughput_date;
        assertPartialUnique(data.equipment_id, day);
        const row: Row = {
          id: `dt-${++store.seq}`,
          site_id: data.site_id,
          equipment_id: data.equipment_id,
          throughput_date: day,
          units_processed: data.units_processed,
          run_hours: data.run_hours,
          notes: data.notes ?? null,
          created_by: data.created_by ?? null,
          actor_label: data.actor_label ?? null,
          voided_at: null,
          voided_by: null,
          created_at: new Date('2026-08-07T12:00:00Z'),
        };
        store.rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: UpdateData }) => {
        const row = store.rows.find((r) => r.id === where.id)!;
        if (data.voided_at === undefined) {
          assertPartialUnique(row.equipment_id, row.throughput_date, row.id);
        }
        Object.assign(row, data);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
    },
  };
  return {
    prisma: {
      equipment: {
        findFirst: async ({ where }: { where: EquipmentWhere }) => {
          expect(where.category).toBe('terex');
          expect(where.is_active).toBe(true);
          expect(where.merged_into_id).toBeNull();
          expect(where.links).toEqual({ some: {} });
          return store.machine;
        },
      },
      equipmentDailyThroughput: {
        // Real Prisma hands back a DETACHED plain object, so a later `update` does
        // not retro-edit the row a caller already read. Returning the live object
        // here would alias them — and would have let this mock silently rewrite the
        // "before" side of an audit assertion, i.e. measure itself instead of the
        // service. Copies keep the mock honest.
        findFirst: async ({ where }: { where: FindFirstWhere }) => {
          const r = store.rows.find(
            (x) =>
              x.equipment_id === where.equipment_id &&
              x.throughput_date.getTime() === where.throughput_date.getTime() &&
              x.voided_at === null,
          );
          return r ? { ...r } : null;
        },
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = store.rows.find((x) => x.id === where.id);
          return r ? { ...r } : null;
        },
        findMany: async ({ where }: { where: FindManyWhere }) =>
          store.rows.filter((r) => {
            if (where.voided_at === null && r.voided_at !== null) return false;
            const range = where.throughput_date;
            if (range) {
              if (r.throughput_date.getTime() < range.gte.getTime()) return false;
              if (r.throughput_date.getTime() > range.lte.getTime()) return false;
            }
            return true;
          }),
        create: tx.equipmentDailyThroughput.create,
        update: tx.equipmentDailyThroughput.update,
      },
      auditLog: tx.auditLog,
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import {
  DailyThroughputAmendmentRequiredError,
  DailyThroughputValidationError,
  MAX_RUN_HOURS,
  MAX_UNITS_PROCESSED,
  assertDailyThroughputShape,
  enteredThroughputByDay,
  upsertDailyThroughput,
  voidDailyThroughput,
} from './daily-throughput';

const SITE = 'site-woodland';
const TODAY = new Date(Date.UTC(2026, 7, 7)); // 2026-08-07, the Pacific "today"
const YESTERDAY = new Date(Date.UTC(2026, 7, 6));
const MANAGER = { actorUserId: 'user-morena', ip: '203.0.113.9', userAgent: 'vitest' };

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
  store.machine = MACHINE;
  store.seq = 0;
});

describe('assertDailyThroughputShape', () => {
  it('accepts a normal day and returns run hours as a Decimal at scale 2', () => {
    const s = assertDailyThroughputShape(212, 6.5);
    expect(s.unitsProcessed).toBe(212);
    expect(s.runHours).toBeInstanceOf(Prisma.Decimal);
    // Stored at Decimal(5,2)…
    expect(s.runHours.toFixed(2)).toBe('6.50');
    // …but `Decimal.toString()` normalizes the trailing zero, so the wire value
    // is '6.5'. Pinned deliberately: this is what the API and the UI actually
    // receive, and it matches how `equipment_events.hours_down` already renders.
    expect(s.runHours.toString()).toBe('6.5');
  });

  it('accepts a RECORDED ZERO for units — the machine ran and produced nothing', () => {
    expect(assertDailyThroughputShape(0, 4).unitsProcessed).toBe(0);
  });

  it('refuses negative or fractional units', () => {
    expect(() => assertDailyThroughputShape(-1, 4)).toThrow(DailyThroughputValidationError);
    expect(() => assertDailyThroughputShape(12.5, 4)).toThrow(DailyThroughputValidationError);
  });

  it('refuses a typo far above any real day', () => {
    // 10,630 for 1,063 — the shape of the mistake this bound exists to catch.
    expect(() => assertDailyThroughputShape(MAX_UNITS_PROCESSED + 1, 6)).toThrow(
      /units_processed must be <= 10000/,
    );
  });

  it('refuses run hours that are zero, negative, or longer than a day', () => {
    // A day the machine did not run is the ABSENCE of an entry, not a 0-hour one —
    // and admitting 0 would put a divide-by-zero in the units/hour path.
    expect(() => assertDailyThroughputShape(100, 0)).toThrow(/run_hours must be a positive number/);
    expect(() => assertDailyThroughputShape(100, -2)).toThrow(DailyThroughputValidationError);
    expect(() => assertDailyThroughputShape(100, MAX_RUN_HOURS + 0.01)).toThrow(
      /cannot run more than a day/,
    );
    expect(assertDailyThroughputShape(100, MAX_RUN_HOURS).runHours.toFixed(2)).toBe('24.00');
  });
});

describe('upsertDailyThroughput — same-day entry (ADR-0079 D4)', () => {
  it('records today freely, stamping the REAL actor id and auditing the insert', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      runHours: 6.5,
      actor: MANAGER,
      today: TODAY,
    });

    expect(row.unitsProcessed).toBe(212);
    expect(row.runHours).toBe('6.5');
    expect(row.equipmentId).toBe(MACHINE.id); // scoped by ROW, never a literal id

    // Actor discipline (ADR-0036/0077): a human's entry carries their real id and
    // NO system label. A borrowed id or a `system:` label on a manager's own
    // keystrokes would be a false claim in an append-only table (hard rule #6).
    expect(row.createdBy).toBe('user-morena');
    expect(row.actorLabel).toBeNull();

    expect(store.audits).toHaveLength(1);
    const audit = store.audits[0]!;
    expect(audit.action).toBe('insert');
    expect(audit.table_name).toBe('equipment_daily_throughput');
    expect(audit.actor_user_id).toBe('user-morena');
    expect(audit.actor_label).toBeNull();
    expect(audit.after).toMatchObject({ units_processed: 212, run_hours: '6.5' });
  });

  it('a second same-day entry EDITS the row and audits before AND after', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      runHours: 6.5,
      actor: MANAGER,
      today: TODAY,
    });
    const edited = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 240,
      runHours: 7,
      actor: MANAGER,
      today: TODAY,
    });

    // ONE row, not two — the (equipment, day) uniqueness makes this an edit.
    expect(store.rows.filter((r) => r.voided_at === null)).toHaveLength(1);
    expect(edited.id).toBe('dt-1');
    expect(edited.unitsProcessed).toBe(240);

    const update = store.audits[1]!;
    expect(update.action).toBe('update');
    // The history survives: the audit carries what it WAS, not just what it is.
    expect(update.before).toMatchObject({ units_processed: 212, run_hours: '6.5' });
    expect(update.after).toMatchObject({ units_processed: 240, run_hours: '7' });
  });

  it('a named system actor sets actor_label and leaves created_by NULL', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 100,
      runHours: 4,
      actor: { actorLabel: 'system:terex-daily-probe', ip: null, userAgent: null },
      today: TODAY,
    });
    expect(row.actorLabel).toBe('system:terex-daily-probe');
    expect(row.createdBy).toBeNull();
    expect(store.audits[0]!.actor_user_id).toBeNull();
    expect(store.audits[0]!.actor_label).toBe('system:terex-daily-probe');
  });

  it('refuses a day that has not happened yet', async () => {
    const tomorrow = new Date(Date.UTC(2026, 7, 8));
    await expect(
      upsertDailyThroughput({
        siteId: SITE,
        throughputDate: tomorrow,
        unitsProcessed: 100,
        runHours: 4,
        actor: MANAGER,
        today: TODAY,
      }),
    ).rejects.toThrow(/in the future/);
    expect(store.rows).toHaveLength(0);
  });
});

describe('upsertDailyThroughput — the PRIOR-day refusal (ADR-0079 D4)', () => {
  it('refuses a past day with a 409 requires_amendment and writes NOTHING', async () => {
    const err = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: YESTERDAY,
      unitsProcessed: 190,
      runHours: 5,
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputAmendmentRequiredError);
    const e = err as DailyThroughputAmendmentRequiredError;
    expect(e.status).toBe(409);
    expect(e.toBody()).toEqual({
      error: 'requires_amendment',
      targetDate: '2026-08-06',
      today: '2026-08-07',
      existing: null,
      proposed: { unitsProcessed: 190, runHours: '5' },
    });

    // The refusal is real: no row, and no audit row claiming one.
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('refuses an EDIT to a past day and reports what is on record vs proposed', async () => {
    // A row already exists for yesterday (entered when it WAS today).
    store.rows.push({
      id: 'dt-existing',
      site_id: SITE,
      equipment_id: MACHINE.id,
      throughput_date: YESTERDAY,
      units_processed: 190,
      run_hours: new Prisma.Decimal('5.00'),
      notes: null,
      created_by: 'user-morena',
      actor_label: null,
      voided_at: null,
      voided_by: null,
      created_at: new Date('2026-08-06T20:00:00Z'),
    });

    const err = (await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: YESTERDAY,
      unitsProcessed: 205,
      runHours: 5.5,
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e)) as DailyThroughputAmendmentRequiredError;

    expect(err).toBeInstanceOf(DailyThroughputAmendmentRequiredError);
    expect(err.toBody().existing).toEqual({ unitsProcessed: 190, runHours: '5' });
    expect(err.toBody().proposed).toEqual({ unitsProcessed: 205, runHours: '5.5' });

    // The row on record is UNTOUCHED — the refusal did not half-apply.
    expect(store.rows[0]!.units_processed).toBe(190);
    expect(store.rows[0]!.run_hours.toFixed(2)).toBe('5.00');
    expect(store.audits).toHaveLength(0);
  });
});

describe('(equipment, day) uniqueness', () => {
  it('the partial unique REFUSES a second live row for the same machine-day', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      runHours: 6.5,
      actor: MANAGER,
      today: TODAY,
    });

    // Force the create path past the service's own "existing row ⇒ edit" branch,
    // so what is measured is the INDEX, not the branch. This is the write a second
    // browser tab, a double-click, or a future caller would attempt.
    await expect(
      (await import('@/lib/prisma')).prisma.equipmentDailyThroughput.create({
        data: {
          site_id: SITE,
          equipment_id: MACHINE.id,
          throughput_date: TODAY,
          units_processed: 999,
          run_hours: new Prisma.Decimal('8.00'),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(store.rows.filter((r) => r.voided_at === null)).toHaveLength(1);
  });

  it('a VOIDED row releases its day — the same day can be entered again', async () => {
    const first = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      runHours: 6.5,
      actor: MANAGER,
      today: TODAY,
    });
    await voidDailyThroughput({ id: first.id, siteId: SITE, actor: MANAGER });

    const second = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 240,
      runHours: 7,
      actor: MANAGER,
      today: TODAY,
    });

    // A NEW row (the void was not an edit), and the voided one is retained.
    expect(second.id).not.toBe(first.id);
    expect(store.rows).toHaveLength(2);
    expect(store.rows.filter((r) => r.voided_at === null)).toHaveLength(1);
  });
});

describe('voidDailyThroughput', () => {
  it('soft-voids, audits, and never hard-deletes (hard rule #6)', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      runHours: 6.5,
      actor: MANAGER,
      today: TODAY,
    });
    const voided = await voidDailyThroughput({ id: row.id, siteId: SITE, actor: MANAGER });

    expect(voided.voidedAt).not.toBeNull();
    expect(store.rows).toHaveLength(1); // retained, not removed
    const audit = store.audits.at(-1)!;
    expect(audit.action).toBe('soft_delete');
    expect(audit.actor_user_id).toBe('user-morena');
    // The void records WHAT was voided, so the trail survives the reversal.
    expect(audit.before).toMatchObject({ units_processed: 212, run_hours: '6.5' });
  });

  it('is idempotent — re-voiding writes no second audit row', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      runHours: 6.5,
      actor: MANAGER,
      today: TODAY,
    });
    await voidDailyThroughput({ id: row.id, siteId: SITE, actor: MANAGER });
    const before = store.audits.length;
    await voidDailyThroughput({ id: row.id, siteId: SITE, actor: MANAGER });
    expect(store.audits).toHaveLength(before);
  });

  it('refuses to void another site’s row (hard rule #2)', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      runHours: 6.5,
      actor: MANAGER,
      today: TODAY,
    });
    await expect(
      voidDailyThroughput({ id: row.id, siteId: 'site-eugene', actor: MANAGER }),
    ).rejects.toThrow(/not found/);
    expect(store.rows[0]!.voided_at).toBeNull();
  });
});

describe('enteredThroughputByDay', () => {
  it('keys recorded days and OMITS unrecorded ones (never a zero)', async () => {
    store.rows.push(
      {
        id: 'a',
        site_id: SITE,
        equipment_id: MACHINE.id,
        throughput_date: new Date(Date.UTC(2026, 7, 5)),
        units_processed: 190,
        run_hours: new Prisma.Decimal('5.00'),
        notes: null,
        created_by: 'u',
        actor_label: null,
        voided_at: null,
        voided_by: null,
        created_at: new Date(),
      },
      {
        id: 'b',
        site_id: SITE,
        equipment_id: MACHINE.id,
        throughput_date: new Date(Date.UTC(2026, 7, 6)),
        units_processed: 0,
        run_hours: new Prisma.Decimal('3.00'),
        notes: null,
        created_by: 'u',
        actor_label: null,
        voided_at: null,
        voided_by: null,
        created_at: new Date(),
      },
    );

    const map = await enteredThroughputByDay(
      SITE,
      new Date(Date.UTC(2026, 7, 4)),
      new Date(Date.UTC(2026, 7, 7)),
    );

    // ADR-0081 — provenance travels WITH the figure from the first read, so no
    // downstream render site has to re-infer it (and re-infer it differently).
    expect(map.get('2026-08-05')).toEqual({
      unitsProcessed: 190,
      runHours: 5,
      isWorkbook: false,
    });
    // A recorded ZERO is PRESENT with value 0…
    expect(map.get('2026-08-06')).toEqual({ unitsProcessed: 0, runHours: 3, isWorkbook: false });
    // …and an unrecorded day is ABSENT, which is a different fact entirely.
    expect(map.has('2026-08-04')).toBe(false);
    expect(map.has('2026-08-07')).toBe(false);
    expect(map.size).toBe(2);
  });

  it('ADR-0081 — reads a workbook row as workbook, and a manager row as manager', async () => {
    store.rows.push(
      {
        id: 'imported',
        site_id: SITE,
        equipment_id: MACHINE.id,
        throughput_date: new Date(Date.UTC(2026, 7, 5)),
        units_processed: 146,
        run_hours: new Prisma.Decimal('8.50'),
        notes: null,
        // The import names ITSELF — never a borrowed user id.
        created_by: null,
        actor_label: 'system:workbook-import',
        source: 'workbook_import',
        import_version_id: 'ver-eed9d4cb',
        voided_at: null,
        voided_by: null,
        created_at: new Date(),
      } as (typeof store.rows)[number],
      {
        id: 'typed',
        site_id: SITE,
        equipment_id: MACHINE.id,
        throughput_date: new Date(Date.UTC(2026, 7, 6)),
        units_processed: 412,
        run_hours: new Prisma.Decimal('6.25'),
        notes: null,
        created_by: 'user-jt',
        actor_label: null,
        source: 'manager',
        import_version_id: null,
        voided_at: null,
        voided_by: null,
        created_at: new Date(),
      } as (typeof store.rows)[number],
    );

    const map = await enteredThroughputByDay(
      SITE,
      new Date(Date.UTC(2026, 7, 4)),
      new Date(Date.UTC(2026, 7, 7)),
    );

    expect(map.get('2026-08-05')).toEqual({
      unitsProcessed: 146,
      runHours: 8.5,
      isWorkbook: true,
    });
    expect(map.get('2026-08-06')).toEqual({
      unitsProcessed: 412,
      runHours: 6.25,
      isWorkbook: false,
    });
  });

  it('is empty at a site with no registered machine', async () => {
    store.machine = null;
    const map = await enteredThroughputByDay(
      'site-eugene',
      new Date(Date.UTC(2026, 7, 4)),
      new Date(Date.UTC(2026, 7, 7)),
    );
    expect(map.size).toBe(0);
  });
});
