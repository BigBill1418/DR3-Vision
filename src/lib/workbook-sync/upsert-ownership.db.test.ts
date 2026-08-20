// ADR-0123 — the ownership guard, against real Postgres.
//
// ## Why the mocked suite is not sufficient on its own
//
// `upsert.test.ts` proves the guard against `FakePrisma`, and `FakePrisma` is a
// double I extended in the same change to understand `updateMany`'s `source`
// predicate. A guard proven only against a double I taught the rule to is a
// guard proven against myself. The thing that has to be true is that POSTGRES
// evaluates `WHERE id = … AND source <> 'manual'` on the row version actually
// being written — which is the entire reason the check rides on the statement
// rather than on the `findUnique` above it (ADR-0119 D2).
//
// ## Recorded red — the guard's predicate removed (`where: { id: existing.id }`)
//
//     × the manual figure and its ownership both survive a sync tick
//       → expected { upserted: 1, overwritten: 1, …(1) } to deeply equal
//         { upserted: +0, overwritten: +0, …(1) }
//     × a correction that lands MID-TICK is not overwritten by a check that
//       already passed
//       → expected +0 to be 1
//     × a refused day writes NO audit row, on every tick
//       → tick 0 did not refuse: expected +0 to be 1
//     Tests  3 failed | 2 passed (5)
//
// The two that stay green are the ones that must: the mymrc overwrite (the
// lattice's unchanged edge) and the plain insert (the positive control that
// stops a guard which refuses everything from passing this file).
//
// The numbers are Bill's, deliberately: 970/100 in the workbook, 960/110 as the
// correction. See §Context in the ADR for what prod actually held.
//
// ## Running it
//
//     npx vitest run --no-file-parallelism upsert-ownership.db.test.ts
//
// with `DATABASE_URL` and `DR3_TEST_DATABASE_URL` both pointed at a migrated
// scratch database. CI's db lane does this for every `db.test.ts` file.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { upsertDailyProduction } from './upsert';
import type { DailyProductionRow } from './daily-adapter';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// The service under test takes its client as an argument, so the two-URL trap
// that `processed-units.db.test.ts` guards against cannot bite here — but the
// assertion is kept so a future refactor to the `@/lib/prisma` singleton cannot
// silently start writing a different database than the assertions read.
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error('upsert-ownership.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0123-ownership';
const SITE = `${NS}-site`;
const DAY_ISO = '2026-08-19';

const SITE_FIELDS = {
  code: NS,
  name: 'DR3 Workbook Ownership Probe',
  jurisdiction: 'california' as const,
  mrc_program_code: 'MRC-CA-TEST',
  customer_service_open: '08:00',
  customer_service_close: '16:00',
  recycling_rate_target_pct: 75,
  records_retention_years: 4,
  inbound_processing_deadline_days: 45,
  mymrc_inbound_submission_business_days: 3,
  mymrc_processed_submission_business_days: 1,
  dock_sla_minutes: 60,
  reconciliation_target_pct: 97,
  billing_cadence: 'end_of_month_only' as const,
};

/** What the spreadsheet says. Bill's numbers. */
function workbookRow(): DailyProductionRow {
  return {
    productionDate: DAY_ISO,
    strippedProgram: 970,
    strippedNonProgram: 100,
    strippedNonProgramInferred: false,
    materialTicketNumber: 'M-186301',
    savedUnits: null,
  };
}

async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "processed_units_daily" WHERE "site_id" = '${SITE}'`);
  await d.$executeRawUnsafe(
    `DELETE FROM "audit_log" WHERE "table_name" = 'processed_units_daily'
       AND "actor_label" LIKE 'system:workbook-sync:${NS}%'`,
  );
}

async function seed(d: any): Promise<void> {
  await cleanup(d);
  await d.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
}

/** The row as a person left it: corrected figures, ownership claimed. */
async function seedManualCorrection(d: any): Promise<void> {
  await d.$executeRawUnsafe(`
    INSERT INTO "processed_units_daily"
      ("id","site_id","production_date","stripped_program","stripped_non_program",
       "material_ticket_number","source","created_at","updated_at")
    VALUES ('${NS}-row','${SITE}','${DAY_ISO}',960,110,'M-186301','manual',now(),now())
  `);
}

async function readRow(d: any) {
  const rows = await d.$queryRawUnsafe(
    `SELECT "stripped_program"::text AS prog, "stripped_non_program"::text AS np,
            "source"::text AS source, "import_id" AS import_id
       FROM "processed_units_daily" WHERE "id" = '${NS}-row'`,
  );
  return rows[0] as { prog: string; np: string; source: string; import_id: string | null };
}

describe.skipIf(!REAL_DB)('the workbook does not overwrite a human correction', () => {
  beforeEach(async () => {
    db ??= new PrismaClient({ datasources: { db: { url: REAL_DB! } } });
    await seed(db);
  });

  afterAll(async () => {
    if (db) {
      await cleanup(db);
      await db.$disconnect();
    }
  });

  it('the manual figure and its ownership both survive a sync tick', async () => {
    await seedManualCorrection(db);

    const res = await db.$transaction((tx: any) =>
      upsertDailyProduction({
        db: tx,
        siteId: SITE,
        syncRunId: `${NS}-run-1`,
        rows: [workbookRow()],
      }),
    );

    expect(res).toEqual({ upserted: 0, overwritten: 0, skippedManual: 1 });

    const row = await readRow(db);
    // Both figures. The non-program half matters as much as the program half:
    // 970/100 and 960/110 have the SAME total, so a test that checked only the
    // total would pass on the clobber.
    expect(Number(row.prog)).toBe(960);
    expect(Number(row.np)).toBe(110);
    // Ownership stands. Had it flipped to 'import', the MyMRC bridge would also
    // be locked out of the row permanently — the second, quieter half of the
    // defect (see `upsert.ts` "Worse:").
    expect(row.source).toBe('manual');
    expect(row.import_id).toBeNull();
  });

  it('a correction that lands MID-TICK is not overwritten by a check that already passed', async () => {
    // The reason the guard is on the WRITING statement and not on the read.
    // Under READ COMMITTED, a `findUnique` taken before the correction commits
    // sees `source = 'import'` and a check based on it passes — the write must
    // re-evaluate the predicate against the row version it is about to replace.
    //
    // Sequenced deterministically rather than by racing threads: the row starts
    // as `import`, so the read inside `upsertDailyProduction` observes `import`
    // and `disagrees()` is true; the correction commits from a second connection
    // before the transaction's write statement runs.
    await db.$executeRawUnsafe(`
      INSERT INTO "processed_units_daily"
        ("id","site_id","production_date","stripped_program","stripped_non_program",
         "material_ticket_number","source","import_id","created_at","updated_at")
      VALUES ('${NS}-row','${SITE}','${DAY_ISO}',900,50,'M-186301','import','older-run',now(),now())
    `);

    const other = new PrismaClient({ datasources: { db: { url: REAL_DB! } } });
    try {
      const res = await db.$transaction(async (tx: any) => {
        // The read the guard used to depend on. It sees `import`.
        const seen = await tx.processedUnitsDaily.findUnique({
          where: {
            site_id_production_date: {
              site_id: SITE,
              production_date: new Date(`${DAY_ISO}T00:00:00.000Z`),
            },
          },
          select: { source: true },
        });
        expect(seen?.source, 'the read must observe the PRE-correction state').toBe('import');

        // A person corrects the day, on another connection, and commits.
        await other.$executeRawUnsafe(`
          UPDATE "processed_units_daily"
             SET "stripped_program" = 960, "stripped_non_program" = 110,
                 "source" = 'manual', "import_id" = NULL, "updated_at" = now()
           WHERE "id" = '${NS}-row'
        `);

        // Now the sync writes. A guard evaluated on the read above would have
        // passed and clobbered.
        return upsertDailyProduction({
          db: tx,
          siteId: SITE,
          syncRunId: `${NS}-run-2`,
          rows: [workbookRow()],
        });
      });

      expect(res.skippedManual).toBe(1);
      expect(res.upserted).toBe(0);
    } finally {
      await other.$disconnect();
    }

    const row = await readRow(db);
    expect(Number(row.prog)).toBe(960);
    expect(Number(row.np)).toBe(110);
    expect(row.source).toBe('manual');
  });

  it('still overwrites a MYMRC row — the lattice is manual > import > mymrc', async () => {
    // The half that must NOT change. A guard that also yielded to `mymrc` would
    // silently retire workbook-wins (ADR-0049 D3), which is a far larger change
    // than this ADR makes, and it would do it invisibly.
    await db.$executeRawUnsafe(`
      INSERT INTO "processed_units_daily"
        ("id","site_id","production_date","stripped_program","stripped_non_program",
         "material_ticket_number","source","created_at","updated_at")
      VALUES ('${NS}-row','${SITE}','${DAY_ISO}',900,50,'M-186301','mymrc',now(),now())
    `);

    const res = await db.$transaction((tx: any) =>
      upsertDailyProduction({
        db: tx,
        siteId: SITE,
        syncRunId: `${NS}-run-3`,
        rows: [workbookRow()],
      }),
    );
    expect(res).toEqual({ upserted: 1, overwritten: 1, skippedManual: 0 });

    const row = await readRow(db);
    expect(Number(row.prog)).toBe(970);
    expect(row.source).toBe('import');
  });

  it('a refused day writes NO audit row, on every tick', async () => {
    // The sync re-reads the same file every ten minutes during business hours.
    // One audit row per refusal is ~84 rows a day per disputed day, in a table
    // that is append-only and must never be cleaned up (hard rule #6). The count
    // on the run ledger is the readable surface instead.
    await seedManualCorrection(db);

    for (let tick = 0; tick < 6; tick++) {
      const res = await db.$transaction((tx: any) =>
        upsertDailyProduction({
          db: tx,
          siteId: SITE,
          syncRunId: `${NS}-run-tick-${tick}`,
          rows: [workbookRow()],
        }),
      );
      expect(res.skippedManual, `tick ${tick} did not refuse`).toBe(1);
    }

    const audits = (await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "audit_log"
        WHERE "table_name" = 'processed_units_daily'
          AND "actor_label" LIKE 'system:workbook-sync:${NS}%'`,
    )) as Array<{ n: number }>;
    expect(audits[0]!.n).toBe(0);

    const row = await readRow(db);
    expect(Number(row.prog)).toBe(960);
    expect(row.source).toBe('manual');
  });

  it('an untouched day is still inserted — the guard is not a global stop', async () => {
    // The positive control. Without it, a guard that refused EVERYTHING would
    // pass every case above, and the sync would silently stop working.
    const res = await db.$transaction((tx: any) =>
      upsertDailyProduction({
        db: tx,
        siteId: SITE,
        syncRunId: `${NS}-run-4`,
        rows: [workbookRow()],
      }),
    );
    expect(res).toEqual({ upserted: 1, overwritten: 0, skippedManual: 0 });

    const rows = (await db.$queryRawUnsafe(
      `SELECT "stripped_program"::text AS prog, "source"::text AS source
         FROM "processed_units_daily" WHERE "site_id" = '${SITE}'`,
    )) as Array<{ prog: string; source: string }>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.prog)).toBe(970);
    expect(rows[0]!.source).toBe('import');
  });
});
