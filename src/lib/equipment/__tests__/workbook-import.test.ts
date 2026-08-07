// ADR-0081 — the import's database behaviour, pinned.
//
// ── WHY THE FAKE PARSES THE SQL ─────────────────────────────────────────────
// The JT-wins rule lives in ONE clause of ONE statement:
//
//   ON CONFLICT (...) DO UPDATE SET ... WHERE "…"."source" = 'workbook_import'
//
// A fake that simply implemented "manager rows are protected" would ENFORCE the
// rule itself, and deleting that clause from the production SQL would leave the
// suite green — the test would be measuring the mock, not the code. So the fake
// below READS THE STATEMENT IT IS GIVEN: it applies the guard only if the SQL it
// received actually carries it. Deleting the clause therefore really does change
// the observed outcome, and the red names the manager's real number.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  WORKBOOK_IMPORT_ACTOR,
  importWorkbookHistory,
  type ImportDb,
  type ImportTx,
  type ReadWorkbook,
} from '../workbook-import';
import { WORKBOOK_IMPORT_SOURCE } from '../daily-throughput';
import type { Cell } from '@/lib/doc-ingest/trailer-extract';
import type { PublishedTotals } from '@/lib/doc-ingest/terex-monthly-extract';

const SITE = 'site-woodland';
const MACHINE = 'eq-terex-7e35a4aa';
const V1 = 'ver-0d59cf71';
const V2 = 'ver-eed9d4cb';

const EMPTY: Cell = { text: '', num: null, date: null };
const n = (v: number): Cell => ({ text: String(v), num: v, date: null });
const t = (v: string): Cell => ({ text: v, num: null, date: null });

interface DayFixture {
  day: number;
  pc?: number;
  hours?: number;
}

function monthlyTab(name: string, month: string, year: string, days: DayFixture[]) {
  const cells: Cell[][] = [
    [t('Terex Operating Data'), EMPTY, EMPTY, t(month), t(year)],
    [
      EMPTY,
      t('Pocket coil '),
      t('Springs'),
      t('Wood'),
      t('Start Hours'),
      t('End Hours'),
      t('Day Total Hrs Used'),
    ],
  ];
  for (const d of days) {
    cells.push([
      n(d.day),
      d.pc === undefined ? EMPTY : n(d.pc),
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      d.hours === undefined ? EMPTY : n(d.hours),
    ]);
  }
  const units = days.reduce((s, d) => s + (d.pc ?? 0), 0);
  const hours = days.reduce((s, d) => s + (d.hours ?? 0), 0);
  cells.push([EMPTY, n(units), n(0), n(0), EMPTY, EMPTY, n(hours)]);
  return { tab: { name, cells }, units, hours, firstRow: 3, lastRow: 2 + days.length };
}

/** A workbook reader that returns fixture cells — no exceljs, real extraction. */
function fakeWorkbook(days: DayFixture[]): () => Promise<ReadWorkbook> {
  const { tab, units, hours, firstRow, lastRow } = monthlyTab('Jul26', 'July', '2026', days);
  const published = new Map<string, PublishedTotals>([
    [
      'Jul26',
      {
        units,
        hours,
        unitsRange: { firstRow, lastRow },
        hoursRange: { firstRow, lastRow },
        overviewHours: null,
        overviewAvgPocketCoil: null,
      },
    ],
  ]);
  return () => Promise.resolve({ sheets: [tab], published });
}

interface StoredRow {
  equipment_id: string;
  throughput_date: string;
  units_processed: number;
  run_hours: number;
  source: string;
  import_version_id: string | null;
  actor_label: string | null;
  created_by: string | null;
}

/**
 * A database that behaves like the real one for the two statements this module
 * issues — and, crucially, decides the conflict from the SQL TEXT it is handed.
 */
class FakeDb implements ImportDb {
  rows: StoredRow[] = [];
  auditRows: Record<string, unknown>[] = [];
  statements: string[] = [];
  /** Set when anything reaches for a table this module must never touch. */
  forbiddenAccess: string[] = [];

  equipmentDailyThroughput = {
    count: (args: { where: { equipment_id: string; import_version_id: string } }) =>
      Promise.resolve(
        this.rows.filter(
          (r) =>
            r.equipment_id === args.where.equipment_id &&
            r.import_version_id === args.where.import_version_id,
        ).length,
      ),
  };

  /**
   * `processed_units_daily` must NEVER be written by this module.
   *
   * A GETTER that records and then THROWS, rather than an absent property. An
   * absent property would make a violation fail as `undefined is not an object`
   * somewhere downstream; this makes the very ACT of reaching for the table the
   * observable event, and names it. `forbiddenAccess` stays empty on a correct
   * run, so the assertion is about access rather than about contents happening
   * to be unchanged.
   */
  get processedUnitsDaily(): { create(): Promise<never> } {
    this.forbiddenAccess.push('processedUnitsDaily');
    throw new Error('ADR-0081: the workbook import must never touch processed_units_daily');
  }

  $transaction<T>(fn: (tx: ImportTx) => Promise<T>): Promise<T> {
    const tx: ImportTx = {
      equipmentDailyThroughput: {
        deleteMany: (args) => {
          const before = this.rows.length;
          this.rows = this.rows.filter(
            (r) => !(r.equipment_id === args.where.equipment_id && r.source === args.where.source),
          );
          return Promise.resolve({ count: before - this.rows.length });
        },
      },
      $executeRaw: (strings, ...values) => {
        const sql = strings.join('?');
        this.statements.push(sql);

        // Parameters, in the order the production statement binds them.
        const [siteId, equipmentId, date, units, runHours, , actorLabel, source, versionId] =
          values as [
            string,
            string,
            Date,
            number,
            { toString(): string },
            unknown,
            string,
            string,
            string,
          ];
        void siteId;

        const dateISO =
          date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
        const incoming: StoredRow = {
          equipment_id: equipmentId,
          throughput_date: dateISO,
          units_processed: units,
          run_hours: Number(runHours.toString()),
          source,
          import_version_id: versionId,
          actor_label: actorLabel,
          created_by: null,
        };

        const existing = this.rows.find(
          (r) => r.equipment_id === equipmentId && r.throughput_date === dateISO,
        );
        if (!existing) {
          this.rows.push(incoming);
          return Promise.resolve(1);
        }

        // ── THE POINT OF THIS FAKE ────────────────────────────────────────
        // Read the guard out of the STATEMENT. If the production SQL stops
        // carrying it, this fake stops applying it, and the manager's row is
        // overwritten — which is exactly what the falsification must observe.
        const hasJtWinsGuard = /"equipment_daily_throughput"\."source"\s*=\s*\?/.test(sql);
        if (hasJtWinsGuard && existing.source !== WORKBOOK_IMPORT_SOURCE) {
          return Promise.resolve(0); // DO UPDATE ... WHERE was false. Nothing happened.
        }
        existing.units_processed = incoming.units_processed;
        existing.run_hours = incoming.run_hours;
        existing.import_version_id = incoming.import_version_id;
        return Promise.resolve(1);
      },
      auditLog: {
        create: (args) => {
          this.auditRows.push(args.data);
          return Promise.resolve({});
        },
      },
    };
    return fn(tx);
  }
}

const DAYS: DayFixture[] = [
  { day: 1, pc: 146, hours: 8.5 },
  { day: 2, pc: 153, hours: 7.25 },
  { day: 3, pc: 163, hours: 7.85 },
];

function run(db: FakeDb, versionId: string, opts: { apply?: boolean; days?: DayFixture[] } = {}) {
  return importWorkbookHistory({
    siteId: SITE,
    equipmentId: MACHINE,
    versionId,
    bytes: new Uint8Array(),
    apply: opts.apply ?? true,
    prisma: db,
    readWorkbook: fakeWorkbook(opts.days ?? DAYS),
  });
}

describe('import.idempotent-same-version', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it('the same revision twice writes nothing the second time', async () => {
    const first = await run(db, V2);
    expect(first.applied).toBe(true);
    expect(first.rowsWritten).toBe(3);
    expect(db.rows).toHaveLength(3);

    const second = await run(db, V2);
    expect(second.alreadyApplied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.rowsWritten).toBe(0);
    // Not merely "the same count" — the SAME ROWS, unduplicated.
    expect(db.rows).toHaveLength(3);
    expect(db.rows.map((r) => r.throughput_date)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
    // A no-op writes no audit row either; a trail that records work that did not
    // happen is worse than no trail.
    expect(db.auditRows).toHaveLength(1);
  });

  it('a preview writes nothing at all', async () => {
    const preview = await run(db, V2, { apply: false });
    expect(preview.applied).toBe(false);
    expect(preview.rowsOffered).toBe(3);
    expect(db.rows).toHaveLength(0);
    expect(db.auditRows).toHaveLength(0);
    // The preview still reports what it WOULD do, from the same extraction.
    expect(preview.dateRange).toEqual({ firstISO: '2026-07-01', lastISO: '2026-07-03' });
  });
});

describe('import.newer-version-supersedes', () => {
  it('replaces the prior revision rather than accumulating beside it', async () => {
    const db = new FakeDb();
    await run(db, V1);
    expect(db.rows).toHaveLength(3);
    expect(db.rows.every((r) => r.import_version_id === V1)).toBe(true);

    // The newer revision corrects day 2 and drops day 3 entirely.
    const second = await run(db, V2, {
      days: [
        { day: 1, pc: 146, hours: 8.5 },
        { day: 2, pc: 999, hours: 7.25 },
      ],
    });

    expect(second.applied).toBe(true);
    expect(second.rowsSuperseded).toBe(3);
    // NEVER ADDITIVE. Day 3 is gone because the new revision does not carry it —
    // an additive import would leave a stale 163 sitting there forever, and
    // nothing downstream could tell it was orphaned.
    expect(db.rows).toHaveLength(2);
    expect(db.rows.map((r) => r.throughput_date)).toEqual(['2026-07-01', '2026-07-02']);
    expect(db.rows.find((r) => r.throughput_date === '2026-07-02')!.units_processed).toBe(999);
    expect(db.rows.every((r) => r.import_version_id === V2)).toBe(true);
  });

  it('supersession leaves MANAGER rows untouched', async () => {
    const db = new FakeDb();
    db.rows.push({
      equipment_id: MACHINE,
      throughput_date: '2026-07-02',
      units_processed: 412,
      run_hours: 6.25,
      source: 'manager',
      import_version_id: null,
      actor_label: null,
      created_by: 'user-jt',
    });
    await run(db, V1);
    await run(db, V2);

    const manager = db.rows.find((r) => r.throughput_date === '2026-07-02')!;
    expect(manager.source).toBe('manager');
    expect(manager.units_processed).toBe(412);
    expect(manager.created_by).toBe('user-jt');
  });
});

describe('import.jt-wins-on-conflict', () => {
  // ── THE FALSIFICATION ─────────────────────────────────────────────────────
  // Deleting `WHERE "equipment_daily_throughput"."source" = 'workbook_import'`
  // from the production statement makes this red, and the red reads:
  //
  //   AssertionError: expected 153 to be 412
  //     - Expected:  412
  //     + Received:  153
  //
  // 412 is JT's real entry for that day and 153 is the sheet's figure that
  // silently replaced it. Both are real production-shaped numbers, so the
  // failure names the actual wrong value rather than an `undefined` that would
  // prove only that a field went missing.
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    db.rows.push({
      equipment_id: MACHINE,
      throughput_date: '2026-07-02',
      units_processed: 412,
      run_hours: 6.25,
      source: 'manager',
      import_version_id: null,
      actor_label: null,
      created_by: 'user-jt',
    });
  });

  it("a manager's row is NEVER overwritten by the sheet", async () => {
    await run(db, V2);

    const day2 = db.rows.find((r) => r.throughput_date === '2026-07-02')!;
    expect(day2.units_processed).toBe(412);
    expect(day2.run_hours).toBe(6.25);
    expect(day2.source).toBe('manager');
    expect(day2.import_version_id).toBeNull();
  });

  it('the yielded day is REPORTED, not silently dropped', async () => {
    const report = await run(db, V2);
    // A non-zero count here is the feature operating, so it has to be legible.
    expect(report.rowsYieldedToManager).toEqual(['2026-07-02']);
    expect(report.rowsWritten).toBe(2);
    expect(report.rowsOffered).toBe(3);
  });

  it('the guard is actually IN the statement (not just in this fake)', async () => {
    await run(db, V2);
    const upsert = db.statements.find((s) => s.includes('ON CONFLICT'))!;
    expect(upsert).toBeDefined();
    // Pinning the clause itself: if a future edit drops it, this fails HERE with
    // a clear cause, rather than only showing up as a mysteriously overwritten
    // manager row three assertions away.
    expect(upsert).toMatch(/DO UPDATE SET/);
    expect(upsert).toMatch(/"equipment_daily_throughput"\."source"\s*=/);
    expect(upsert).toMatch(
      /ON CONFLICT \("equipment_id", "throughput_date"\) WHERE "voided_at" IS NULL/,
    );
  });

  it('the other days still import around the manager-owned one', async () => {
    await run(db, V2);
    expect(db.rows).toHaveLength(3);
    const imported = db.rows.filter((r) => r.source === WORKBOOK_IMPORT_SOURCE);
    expect(imported.map((r) => r.throughput_date)).toEqual(['2026-07-01', '2026-07-03']);
  });
});

describe('import.never-writes-processed-units-daily', () => {
  it('never reaches for the floor-wide close table', async () => {
    const db = new FakeDb();

    await run(db, V2);

    // `forbiddenAccess` is appended to by the getter itself, so a non-empty
    // array here means the module genuinely reached for the table.
    expect(db.forbiddenAccess).toEqual([]);
    // And nothing in the statements this module issued names that table.
    for (const sql of db.statements) {
      expect(sql).not.toMatch(/processed_units_daily/);
    }
  });
});

describe('actor discipline', () => {
  it("names itself rather than borrowing a person's id", async () => {
    const db = new FakeDb();
    await run(db, V2);
    for (const row of db.rows) {
      expect(row.actor_label).toBe(WORKBOOK_IMPORT_ACTOR);
      expect(row.actor_label).toBe('system:workbook-import');
      // ADR-0036 / ADR-0077 — a write with no signed-in human leaves `created_by`
      // NULL rather than writing a false claim into an append-only trail.
      expect(row.created_by).toBeNull();
    }
    expect(db.auditRows[0]).toMatchObject({
      actor_user_id: null,
      actor_label: WORKBOOK_IMPORT_ACTOR,
      table_name: 'equipment_daily_throughput',
    });
  });
});

describe('R5 hard stop reaches the database layer', () => {
  it('a month that does not reconcile applies NOTHING', async () => {
    const db = new FakeDb();
    const { tab } = monthlyTab('Jul26', 'July', '2026', DAYS);
    const published = new Map<string, PublishedTotals>([
      [
        'Jul26',
        {
          // 2% out — four times the tolerance.
          units: 462 * 1.02,
          hours: 23.6,
          unitsRange: { firstRow: 3, lastRow: 5 },
          hoursRange: { firstRow: 3, lastRow: 5 },
          overviewHours: null,
          overviewAvgPocketCoil: null,
        },
      ],
    ]);

    const report = await importWorkbookHistory({
      siteId: SITE,
      equipmentId: MACHINE,
      versionId: V2,
      bytes: new Uint8Array(),
      apply: true,
      prisma: db,
      readWorkbook: () => Promise.resolve({ sheets: [tab], published }),
    });

    expect(report.stagedForReconciliation).toBe(true);
    expect(report.offendingTabs).toEqual(['Jul26']);
    expect(report.applied).toBe(false);
    // The decisive assertion: `apply: true` was requested and the database is
    // still empty. A partial application of a workbook one of whose months does
    // not add up is the worst available outcome, because it looks like it worked.
    expect(db.rows).toEqual([]);
    expect(db.statements).toEqual([]);
    expect(db.auditRows).toEqual([]);
  });
});
