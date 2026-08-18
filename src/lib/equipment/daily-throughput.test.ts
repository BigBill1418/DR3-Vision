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
  // ADR-0107 — the two hour-METER readings `run_hours` is the difference of.
  start_hours: Prisma.Decimal | null;
  end_hours: Prisma.Decimal | null;
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
  start_hours?: Prisma.Decimal | null;
  end_hours?: Prisma.Decimal | null;
  notes?: string | null;
  created_by?: string | null;
  actor_label?: string | null;
}

interface UpdateData {
  units_processed?: number;
  run_hours?: Prisma.Decimal;
  start_hours?: Prisma.Decimal | null;
  end_hours?: Prisma.Decimal | null;
  notes?: string | null;
  voided_at?: Date;
  voided_by?: string | null;
}

interface FindFirstWhere {
  equipment_id: string;
  // Exact day for the upsert's "is there a live row?" lookup; `{ lt }` for
  // ADR-0107's carry-forward lookup, which asks for the nearest EARLIER day.
  throughput_date: Date | { lt: Date };
  voided_at: null;
  end_hours?: { not: null };
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
          start_hours: data.start_hours ?? null,
          end_hours: data.end_hours ?? null,
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
        findFirst: async ({
          where,
          orderBy,
        }: {
          where: FindFirstWhere;
          orderBy?: { throughput_date?: 'asc' | 'desc' };
        }) => {
          const day = where.throughput_date;
          let hits = store.rows.filter(
            (x) =>
              x.equipment_id === where.equipment_id &&
              x.voided_at === null &&
              (day instanceof Date
                ? x.throughput_date.getTime() === day.getTime()
                : x.throughput_date.getTime() < day.lt.getTime()) &&
              // ADR-0107 — a legacy row with no meter must not be a prefill
              // candidate; the real query filters it out and so must the mock,
              // or the carry-forward test would pass against a null reading.
              (where.end_hours?.not === null ? x.end_hours !== null : true),
          );
          if (orderBy?.throughput_date === 'desc') {
            hits = [...hits].sort(
              (a, b) => b.throughput_date.getTime() - a.throughput_date.getTime(),
            );
          }
          const r = hits[0];
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
  listDailyThroughput,
  previousEndHours,
  upsertDailyThroughput,
  voidDailyThroughput,
} from './daily-throughput';

const SITE = 'site-woodland';
const TODAY = new Date(Date.UTC(2026, 7, 7)); // 2026-08-07, the Pacific "today"
const YESTERDAY = new Date(Date.UTC(2026, 7, 6));
const MANAGER = { actorUserId: 'user-morena', ip: '203.0.113.9', userAgent: 'vitest' };

// ADR-0106 — the month bound. `LAST_MONTH` is deliberately the day IMMEDIATELY
// before `MONTH_START`: an off-by-one in the boundary shows up here and nowhere
// else, and a date chosen further back would pass a comparison that is wrong by
// exactly one day.
const MONTH_START = new Date(Date.UTC(2026, 7, 1)); // 2026-08-01
const LAST_MONTH = new Date(Date.UTC(2026, 6, 31)); // 2026-07-31
const TWO_DAYS_BACK = new Date(Date.UTC(2026, 7, 5)); // 2026-08-05, in-month
const REASON = 'JT was out Friday; numbers came off the sheet Monday.';

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
  store.machine = MACHINE;
  store.seq = 0;
});

describe('assertDailyThroughputShape (ADR-0107 — run hours are DERIVED)', () => {
  it('derives run hours from the meter pair and returns all three as Decimals', () => {
    // The real shape of the sheet's Aug26 rows: a cumulative meter that climbs.
    const s = assertDailyThroughputShape(212, 2798.5, 2805);
    expect(s.unitsProcessed).toBe(212);
    expect(s.startHours.toFixed(2)).toBe('2798.50');
    expect(s.endHours.toFixed(2)).toBe('2805.00');
    expect(s.runHours).toBeInstanceOf(Prisma.Decimal);
    // 2805 − 2798.5 = 6.5, computed — never typed.
    expect(s.runHours.toFixed(2)).toBe('6.50');
    // `Decimal.toString()` normalizes the trailing zero, so the wire value is
    // '6.5'. Pinned deliberately: this is what the API and the UI receive, and
    // it matches how `equipment_events.hours_down` already renders.
    expect(s.runHours.toString()).toBe('6.5');
  });

  it('accepts a RECORDED ZERO for units — the machine ran and produced nothing', () => {
    expect(assertDailyThroughputShape(0, 2800, 2804).unitsProcessed).toBe(0);
  });

  it('refuses negative or fractional units', () => {
    expect(() => assertDailyThroughputShape(-1, 2800, 2804)).toThrow(
      DailyThroughputValidationError,
    );
    expect(() => assertDailyThroughputShape(12.5, 2800, 2804)).toThrow(
      DailyThroughputValidationError,
    );
  });

  it('refuses a typo far above any real day', () => {
    // 10,630 for 1,063 — the shape of the mistake this bound exists to catch.
    expect(() => assertDailyThroughputShape(MAX_UNITS_PROCESSED + 1, 2800, 2806)).toThrow(
      /units_processed must be <= 10000/,
    );
  });

  it('REFUSES End <= Start — the machine never runs overnight', () => {
    // A transposed pair. The sheet carries Start forward from the prior End, so
    // the two arrive in the same order every day; reversing them is a keying
    // error, and a "negative day" is the one thing it can never be.
    expect(() => assertDailyThroughputShape(100, 2805, 2798.5)).toThrow(
      /end_hours must be greater than start_hours/i,
    );
    // Yesterday's End typed into both boxes.
    expect(() => assertDailyThroughputShape(100, 2805, 2805)).toThrow(
      /end_hours must be greater than start_hours/i,
    );
  });

  it('REFUSES a derived day longer than 24 hours', () => {
    // 2,830 for 2,803 — a fat-fingered End. The ADR-0079 bound now catches a
    // mis-keyed METER rather than a mis-keyed duration.
    expect(() => assertDailyThroughputShape(100, 2803, 2830)).toThrow(/cannot run more than a day/);
    expect(assertDailyThroughputShape(100, 2800, 2800 + MAX_RUN_HOURS).runHours.toFixed(2)).toBe(
      '24.00',
    );
  });

  it('REFUSES a pair whose difference ROUNDS AWAY to zero', () => {
    // At full float precision End > Start, so a naive implementation would
    // accept this and store a run_hours of 0.00 — a divide-by-zero in the
    // units-per-hour path, and a row violating the `end > start` CHECK it was
    // just told it satisfied. Because both readings are rounded to the stored
    // scale BEFORE they are compared, the ordering guard is what catches it.
    expect(() => assertDailyThroughputShape(100, 2800.001, 2800.002)).toThrow(
      /end_hours must be greater than start_hours/i,
    );
  });

  it('refuses a negative or non-finite meter reading', () => {
    expect(() => assertDailyThroughputShape(100, -1, 5)).toThrow(DailyThroughputValidationError);
    expect(() => assertDailyThroughputShape(100, Number.NaN, 5)).toThrow(
      DailyThroughputValidationError,
    );
    expect(() => assertDailyThroughputShape(100, 2800, Number.POSITIVE_INFINITY)).toThrow(
      DailyThroughputValidationError,
    );
  });
});

describe('upsertDailyThroughput — same-day entry (ADR-0079 D4)', () => {
  it('records today freely, stamping the REAL actor id and auditing the insert', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2800,
      endHours: 2806.5,
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
      startHours: 2800,
      endHours: 2806.5,
      actor: MANAGER,
      today: TODAY,
    });
    const edited = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 240,
      startHours: 2800,
      endHours: 2807,
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
      startHours: 2800,
      endHours: 2804,
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
        startHours: 2800,
        endHours: 2804,
        actor: MANAGER,
        today: TODAY,
      }),
    ).rejects.toThrow(/in the future/);
    expect(store.rows).toHaveLength(0);
  });
});

// ADR-0079 D4 originally refused EVERY prior day, and these two tests pinned
// that. ADR-0106 supersedes it for in-month dates, so the boundary they measure
// MOVES — from "before today" to "before this month". They are re-pointed at the
// prior month rather than deleted: the refusal itself is not gone, and a deleted
// test would have quietly stopped checking that it still writes nothing.
describe('upsertDailyThroughput — the PRIOR-MONTH refusal (ADR-0079 D4, as amended by ADR-0106)', () => {
  it('refuses a prior-month day with a 409 requires_amendment and writes NOTHING', async () => {
    const err = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: LAST_MONTH,
      unitsProcessed: 190,
      startHours: 2800,
      endHours: 2805,
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputAmendmentRequiredError);
    const e = err as DailyThroughputAmendmentRequiredError;
    expect(e.status).toBe(409);
    expect(e.toBody()).toEqual({
      error: 'requires_amendment',
      targetDate: '2026-07-31',
      today: '2026-08-07',
      monthStart: '2026-08-01',
      existing: null,
      proposed: { unitsProcessed: 190, runHours: '5' },
    });

    // The refusal is real: no row, and no audit row claiming one.
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('refuses an EDIT to a prior-month day and reports what is on record vs proposed', async () => {
    // A row already exists for that day (entered when it WAS in month).
    store.rows.push({
      id: 'dt-existing',
      site_id: SITE,
      equipment_id: MACHINE.id,
      throughput_date: LAST_MONTH,
      units_processed: 190,
      run_hours: new Prisma.Decimal('5.00'),
      start_hours: null,
      end_hours: null,
      notes: null,
      created_by: 'user-morena',
      actor_label: null,
      voided_at: null,
      voided_by: null,
      created_at: new Date('2026-07-31T20:00:00Z'),
    });

    const err = (await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: LAST_MONTH,
      unitsProcessed: 205,
      startHours: 2800,
      endHours: 2805.5,
      reason: REASON,
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

  it('YESTERDAY is no longer refused — it is in-month, which is the whole change', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: YESTERDAY,
      unitsProcessed: 190,
      startHours: 2800,
      endHours: 2805,
      reason: REASON,
      actor: MANAGER,
      today: TODAY,
    });
    expect(row.throughputDateISO).toBe('2026-08-06');
  });
});

describe('ADR-0106 — a prior day INSIDE the current Pacific month', () => {
  it('ACCEPTS two days back when a reason is given, and audits who/when/why', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TWO_DAYS_BACK,
      unitsProcessed: 188,
      startHours: 2800,
      endHours: 2806.25,
      reason: REASON,
      actor: MANAGER,
      today: TODAY,
    });

    expect(row.throughputDateISO).toBe('2026-08-05');
    expect(row.unitsProcessed).toBe(188);

    // The write is REAL — this is the behaviour ADR-0079 D4 refused.
    expect(store.rows.filter((r) => r.voided_at === null)).toHaveLength(1);

    // who / when / why. `who` is the real manager id (never a borrowed one),
    // `when` is the audit row's own `created_at`, and `why` is the reason —
    // which is the half that did not exist before ADR-0106.
    const audit = store.audits.at(-1)!;
    expect(audit.action).toBe('insert');
    expect(audit.actor_user_id).toBe('user-morena');
    expect(audit.after).toMatchObject({
      prior_day: true,
      prior_day_reason: REASON,
      throughput_date: '2026-08-05',
    });
  });

  it('REFUSES a prior day with no reason, and writes nothing at all', async () => {
    const err = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TWO_DAYS_BACK,
      unitsProcessed: 188,
      startHours: 2800,
      endHours: 2806.25,
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputValidationError);
    expect((err as Error).message).toMatch(/reason/i);

    // A refusal that half-applied would be worse than the refusal it replaced.
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('REFUSES a whitespace-only reason — a required field satisfied by a space is not required', async () => {
    const err = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TWO_DAYS_BACK,
      unitsProcessed: 188,
      startHours: 2800,
      endHours: 2806.25,
      reason: '   ',
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputValidationError);
    expect(store.rows).toHaveLength(0);
  });

  it('EDITS an in-month prior day, auditing the before AND the reason', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TWO_DAYS_BACK,
      unitsProcessed: 188,
      startHours: 2800,
      endHours: 2806.25,
      reason: REASON,
      actor: MANAGER,
      today: TODAY,
    });
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TWO_DAYS_BACK,
      unitsProcessed: 201,
      startHours: 2800,
      endHours: 2806.5,
      reason: 'Recount: two bins were double-counted.',
      actor: MANAGER,
      today: TODAY,
    });

    expect(store.rows.filter((r) => r.voided_at === null)).toHaveLength(1);
    const audit = store.audits.at(-1)!;
    expect(audit.action).toBe('update');
    expect(audit.before).toMatchObject({ units_processed: 188 });
    expect(audit.after).toMatchObject({
      units_processed: 201,
      prior_day: true,
      prior_day_reason: 'Recount: two bins were double-counted.',
    });
  });
});

describe('ADR-0106 — the month floor still refuses a PRIOR month', () => {
  it('refuses 2026-07-31 on 2026-08-07 with 409 requires_amendment, even WITH a reason', async () => {
    const err = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: LAST_MONTH,
      unitsProcessed: 190,
      startHours: 2800,
      endHours: 2805,
      reason: REASON,
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputAmendmentRequiredError);
    const e = err as DailyThroughputAmendmentRequiredError;
    expect(e.status).toBe(409);
    expect(e.toBody()).toEqual({
      error: 'requires_amendment',
      targetDate: '2026-07-31',
      today: '2026-08-07',
      monthStart: '2026-08-01',
      existing: null,
      proposed: { unitsProcessed: 190, runHours: '5' },
    });
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  /**
   * The ONE day a month the bound can be got wrong.
   *
   * `appCurrentMonthStart` takes an INSTANT, but this service holds a `@db.Date`
   * day-key (UTC midnight). Feeding the key `2026-08-01` to it returns
   * **2026-07-01**, because `appToday()` re-reads UTC midnight as an instant —
   * 2026-07-31 17:00 PDT. Measured, not reasoned:
   *
   *   day key                      : 2026-08-01T00:00:00.000Z
   *   appToday(day key)            : 2026-07-31T00:00:00.000Z
   *   appCurrentMonthStart(day key): 2026-07-01T00:00:00.000Z
   *
   * On the 1st that mistake moves the floor a whole month back and ACCEPTS every
   * day of the prior month — a fail-OPEN, on the one day nobody would test by
   * hand. This is why the bound derives from the day-key directly.
   */
  it('on the FIRST of the month, yesterday belongs to the prior month and is refused', async () => {
    const err = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: LAST_MONTH,
      unitsProcessed: 190,
      startHours: 2800,
      endHours: 2805,
      reason: REASON,
      actor: MANAGER,
      today: MONTH_START,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputAmendmentRequiredError);
    expect((err as DailyThroughputAmendmentRequiredError).toBody().monthStart).toBe('2026-08-01');
    expect(store.rows).toHaveLength(0);
  });

  it('the FIRST of the month itself is same-day and needs no reason', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: MONTH_START,
      unitsProcessed: 150,
      startHours: 2800,
      endHours: 2805,
      actor: MANAGER,
      today: MONTH_START,
    });
    expect(row.throughputDateISO).toBe('2026-08-01');
    expect(store.audits.at(-1)!.after).not.toMatchObject({ prior_day: true });
  });
});

describe('ADR-0106 — the same-day path is unchanged', () => {
  it('records today with NO reason, and the audit carries no prior-day marker', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2800,
      endHours: 2806.5,
      actor: MANAGER,
      today: TODAY,
    });

    const after = store.audits[0]!.after as Record<string, unknown>;
    // A same-day entry carries NO prior-day keys. The two meter columns are
    // ADR-0107's addition and are present on every entry, same-day or not —
    // what ADR-0106 promises is that `prior_day` / `prior_day_reason` never
    // appear on a same-day write, which is exactly what this pins.
    expect(Object.keys(after).sort()).toEqual(
      [
        'end_hours',
        'equipment_id',
        'run_hours',
        'start_hours',
        'throughput_date',
        'units_processed',
      ].sort(),
    );
  });

  it('IGNORES a reason supplied on a same-day entry rather than recording a why that has no what', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2800,
      endHours: 2806.5,
      reason: 'not a prior-day change',
      actor: MANAGER,
      today: TODAY,
    });
    const after = store.audits[0]!.after as Record<string, unknown>;
    expect(after['prior_day_reason']).toBeUndefined();
    expect(after['prior_day']).toBeUndefined();
  });
});

describe('ADR-0107 — the meter pair is STORED and run hours are LOCKED', () => {
  it('stores both readings alongside the derived run hours', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2798.5,
      endHours: 2805,
      actor: MANAGER,
      today: TODAY,
    });

    expect(row.startHours).toBe('2798.5');
    expect(row.endHours).toBe('2805');
    expect(row.runHours).toBe('6.5');

    // All three land in the row, so the difference and the pair it came from
    // can never disagree in the database.
    const stored = store.rows[0]!;
    expect(stored.start_hours!.toFixed(2)).toBe('2798.50');
    expect(stored.end_hours!.toFixed(2)).toBe('2805.00');
    expect(stored.run_hours.toFixed(2)).toBe('6.50');
  });

  it('audits the readings, not just the difference', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2798.5,
      endHours: 2805,
      actor: MANAGER,
      today: TODAY,
    });
    expect(store.audits[0]!.after).toMatchObject({
      start_hours: '2798.5',
      end_hours: '2805',
      run_hours: '6.5',
    });
  });

  /**
   * The hand-entry path is GONE, not merely unused.
   *
   * TypeScript removes `runHours` from the argument type, but a JS caller — the
   * route handler forwarding an unvalidated body, a script, a future path —
   * can still pass it. Silently ignoring it would let a caller believe it had
   * set the run hours while the derivation quietly overrode them, which is
   * worse than either accepting or refusing. So it REFUSES.
   */
  it('REFUSES a hand-set runHours rather than ignoring it', async () => {
    const err = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2798.5,
      endHours: 2805,
      runHours: 99,
      actor: MANAGER,
      today: TODAY,
    } as unknown as Parameters<typeof upsertDailyThroughput>[0]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputValidationError);
    expect((err as Error).message).toMatch(/run_hours .*derived|cannot be set by hand/i);
    expect(store.rows).toHaveLength(0);
  });

  it('an EDIT re-derives the run hours from the new pair', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2798.5,
      endHours: 2805,
      actor: MANAGER,
      today: TODAY,
    });
    const edited = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 240,
      startHours: 2798.5,
      endHours: 2806.75,
      actor: MANAGER,
      today: TODAY,
    });

    expect(edited.runHours).toBe('8.25');
    expect(store.audits[1]!.before).toMatchObject({ run_hours: '6.5', start_hours: '2798.5' });
    expect(store.audits[1]!.after).toMatchObject({ run_hours: '8.25', end_hours: '2806.75' });
  });
});

describe('ADR-0107 — pre-ADR-0107 history is NOT backfilled', () => {
  it('reads a legacy row with NULL meters and keeps its recorded run hours', async () => {
    store.rows.push({
      id: 'legacy',
      site_id: SITE,
      equipment_id: MACHINE.id,
      throughput_date: new Date(Date.UTC(2026, 7, 5)),
      units_processed: 190,
      run_hours: new Prisma.Decimal('5.00'),
      // The pair that never existed. Inventing 0 → 5 here would put two
      // fabricated meter readings, indistinguishable from real ones, into the
      // table whose whole purpose is that the number is authoritative.
      start_hours: null,
      end_hours: null,
      notes: null,
      created_by: 'u',
      actor_label: null,
      voided_at: null,
      voided_by: null,
      created_at: new Date(),
    });

    const map = await enteredThroughputByDay(
      SITE,
      new Date(Date.UTC(2026, 7, 4)),
      new Date(Date.UTC(2026, 7, 7)),
    );
    // The day still counts, and still carries its hours.
    expect(map.get('2026-08-05')).toMatchObject({ unitsProcessed: 190, runHours: 5 });
  });

  it('a legacy row surfaces NULL meters rather than a manufactured pair', async () => {
    store.rows.push({
      id: 'legacy',
      site_id: SITE,
      equipment_id: MACHINE.id,
      throughput_date: TODAY,
      units_processed: 190,
      run_hours: new Prisma.Decimal('5.00'),
      start_hours: null,
      end_hours: null,
      notes: null,
      created_by: 'u',
      actor_label: null,
      voided_at: null,
      voided_by: null,
      created_at: new Date(),
    });
    const rows = await listDailyThroughput(SITE);
    expect(rows[0]!.startHours).toBeNull();
    expect(rows[0]!.endHours).toBeNull();
    expect(rows[0]!.runHours).toBe('5');
  });
});

describe('ADR-0107 — Start carries forward from the prior day (the sheet does this by formula)', () => {
  it('returns the most recent PRIOR end reading for the machine', async () => {
    store.rows.push(
      {
        id: 'd1',
        site_id: SITE,
        equipment_id: MACHINE.id,
        throughput_date: new Date(Date.UTC(2026, 7, 4)),
        units_processed: 100,
        run_hours: new Prisma.Decimal('6.00'),
        start_hours: new Prisma.Decimal('2780.00'),
        end_hours: new Prisma.Decimal('2786.00'),
        notes: null,
        created_by: 'u',
        actor_label: null,
        voided_at: null,
        voided_by: null,
        created_at: new Date(),
      },
      {
        id: 'd2',
        site_id: SITE,
        equipment_id: MACHINE.id,
        throughput_date: new Date(Date.UTC(2026, 7, 5)),
        units_processed: 120,
        run_hours: new Prisma.Decimal('7.50'),
        start_hours: new Prisma.Decimal('2786.00'),
        end_hours: new Prisma.Decimal('2793.50'),
        notes: null,
        created_by: 'u',
        actor_label: null,
        voided_at: null,
        voided_by: null,
        created_at: new Date(),
      },
    );

    // Entering 2026-08-06 picks up 2026-08-05's END — the nearest prior day,
    // not the oldest and not the highest.
    const prior = await previousEndHours(SITE, new Date(Date.UTC(2026, 7, 6)));
    expect(prior).toBe('2793.5');
  });

  it('is null when the prior days carry no meter reading (legacy history)', async () => {
    store.rows.push({
      id: 'legacy',
      site_id: SITE,
      equipment_id: MACHINE.id,
      throughput_date: new Date(Date.UTC(2026, 7, 5)),
      units_processed: 190,
      run_hours: new Prisma.Decimal('5.00'),
      start_hours: null,
      end_hours: null,
      notes: null,
      created_by: 'u',
      actor_label: null,
      voided_at: null,
      voided_by: null,
      created_at: new Date(),
    });
    // A legacy day must not prefill anything — there is nothing to carry, and
    // guessing would seed the very fabrication the no-backfill rule refuses.
    expect(await previousEndHours(SITE, new Date(Date.UTC(2026, 7, 6)))).toBeNull();
  });

  it('never carries a reading FORWARD from a later day', async () => {
    store.rows.push({
      id: 'later',
      site_id: SITE,
      equipment_id: MACHINE.id,
      throughput_date: new Date(Date.UTC(2026, 7, 9)),
      units_processed: 120,
      run_hours: new Prisma.Decimal('7.50'),
      start_hours: new Prisma.Decimal('2900.00'),
      end_hours: new Prisma.Decimal('2907.50'),
      notes: null,
      created_by: 'u',
      actor_label: null,
      voided_at: null,
      voided_by: null,
      created_at: new Date(),
    });
    expect(await previousEndHours(SITE, new Date(Date.UTC(2026, 7, 6)))).toBeNull();
  });
});

describe('(equipment, day) uniqueness', () => {
  it('the partial unique REFUSES a second live row for the same machine-day', async () => {
    await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2800,
      endHours: 2806.5,
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
          start_hours: null,
          end_hours: null,
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
      startHours: 2800,
      endHours: 2806.5,
      actor: MANAGER,
      today: TODAY,
    });
    await voidDailyThroughput({ id: first.id, siteId: SITE, actor: MANAGER, today: TODAY });

    const second = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 240,
      startHours: 2800,
      endHours: 2807,
      actor: MANAGER,
      today: TODAY,
    });

    // A NEW row (the void was not an edit), and the voided one is retained.
    expect(second.id).not.toBe(first.id);
    expect(store.rows).toHaveLength(2);
    expect(store.rows.filter((r) => r.voided_at === null)).toHaveLength(1);
  });
});

/**
 * ADR-0106 — the month bound has to hold on EVERY verb that changes a day.
 *
 * `upsertDailyThroughput` is not the only way to change what a day says: a void
 * erases it from every series and the tile. A bound enforced on one verb and not
 * its sibling is not a bound — it is a bound with a documented bypass. Voiding
 * 2026-07-31 makes the machine's July day read "not recorded", which is the same
 * class of backdated change the 409 exists to refuse.
 */
describe('ADR-0106 — the month bound holds on the VOID path too', () => {
  const seedRow = (day: Date) => {
    store.rows.push({
      id: 'dt-old',
      site_id: SITE,
      equipment_id: MACHINE.id,
      throughput_date: day,
      units_processed: 190,
      run_hours: new Prisma.Decimal('5.00'),
      start_hours: null,
      end_hours: null,
      notes: null,
      created_by: 'user-morena',
      actor_label: null,
      voided_at: null,
      voided_by: null,
      created_at: new Date('2026-07-31T20:00:00Z'),
    });
  };

  it('REFUSES to void a prior-MONTH day, and the row stays live', async () => {
    seedRow(LAST_MONTH);
    const err = await voidDailyThroughput({
      id: 'dt-old',
      siteId: SITE,
      reason: REASON,
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputAmendmentRequiredError);
    expect(store.rows[0]!.voided_at).toBeNull();
    expect(store.audits).toHaveLength(0);
  });

  it('REFUSES to void an in-month prior day with no reason', async () => {
    seedRow(TWO_DAYS_BACK);
    const err = await voidDailyThroughput({
      id: 'dt-old',
      siteId: SITE,
      actor: MANAGER,
      today: TODAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DailyThroughputValidationError);
    expect(store.rows[0]!.voided_at).toBeNull();
    expect(store.audits).toHaveLength(0);
  });

  it('ACCEPTS an in-month prior-day void WITH a reason, and audits the why', async () => {
    seedRow(TWO_DAYS_BACK);
    await voidDailyThroughput({
      id: 'dt-old',
      siteId: SITE,
      reason: 'Entered against the wrong machine.',
      actor: MANAGER,
      today: TODAY,
    });

    expect(store.rows[0]!.voided_at).not.toBeNull();
    const audit = store.audits.at(-1)!;
    expect(audit.action).toBe('soft_delete');
    expect(audit.after).toMatchObject({
      prior_day: true,
      prior_day_reason: 'Entered against the wrong machine.',
    });
  });
});

describe('voidDailyThroughput', () => {
  it('soft-voids, audits, and never hard-deletes (hard rule #6)', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2800,
      endHours: 2806.5,
      actor: MANAGER,
      today: TODAY,
    });
    const voided = await voidDailyThroughput({
      id: row.id,
      siteId: SITE,
      actor: MANAGER,
      today: TODAY,
    });

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
      startHours: 2800,
      endHours: 2806.5,
      actor: MANAGER,
      today: TODAY,
    });
    await voidDailyThroughput({ id: row.id, siteId: SITE, actor: MANAGER, today: TODAY });
    const before = store.audits.length;
    await voidDailyThroughput({ id: row.id, siteId: SITE, actor: MANAGER, today: TODAY });
    expect(store.audits).toHaveLength(before);
  });

  it('refuses to void another site’s row (hard rule #2)', async () => {
    const row = await upsertDailyThroughput({
      siteId: SITE,
      throughputDate: TODAY,
      unitsProcessed: 212,
      startHours: 2800,
      endHours: 2806.5,
      actor: MANAGER,
      today: TODAY,
    });
    await expect(
      voidDailyThroughput({ id: row.id, siteId: 'site-eugene', actor: MANAGER, today: TODAY }),
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
        start_hours: null,
        end_hours: null,
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
        start_hours: null,
        end_hours: null,
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
        start_hours: null,
        end_hours: null,
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
        start_hours: null,
        end_hours: null,
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
