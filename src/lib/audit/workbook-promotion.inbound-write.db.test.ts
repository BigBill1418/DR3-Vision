// ADR-0115 (F-5) — inbound promotion writes, against a REAL Prisma client.
//
// The defect this pins: `promoteWorkbookImport` passed `source: 'import'` in the
// `inboundLoad.createMany` payload. `InboundLoad.source` is the `Source?`
// RELATION (where the mattresses came from), NOT a `RecordSource` provenance
// column — ADR-0048 §86-92 says inbound provenance rides on `import_id` alone,
// and this very file says so at its `CONFLICT_TABLES` entry. Prisma rejects the
// unknown argument at VALIDATION time, before the query is sent, which aborts
// the enclosing `$transaction` — so no inbound, outbound, processed, landfilled
// or dropoff row lands, and the promotion ledger row rolls back with them.
//
// Why this suite must use a real client, and why the defect survived from
// 2026-07-06 (`87a605be`, PR #77) to 2026-08-19 without it:
//
//   Both existing promotion suites (`workbook-promotion.test.ts`,
//   `workbook-promotion.source-link.test.ts`) inject a hand-rolled fake whose
//   `createMany` is `async ({ data }) => ({ count: data.length })`. A fake that
//   accepts every payload cannot reject an unknown argument, so it agreed with
//   the bug. `tsc --noEmit` cannot catch it either: Prisma's `SelectSubset`
//   maps only the top-level keys (`data`, `skipDuplicates`) and lets `T['data']`
//   through, so excess-property freshness is gone before the nested check runs.
//
//   The check is therefore only expressible against the real client. It is NOT
//   expressible against a merely *unreachable* one: with a bad DATABASE_URL both
//   the good and the bad payload raise `PrismaClientInitializationError`, so the
//   two branches collapse and the test would pass on the broken code.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter), which
// stands up an ephemeral Postgres 16 and applies the whole migration chain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { inMemoryAliasResolver } from './workbook/site-alias';
import { promoteWorkbookImport, type PromotionScope } from './workbook-promotion';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

// Fixture ids are namespaced so a shared CI database cannot collide with the
// other db.test.ts suites, which run `--no-file-parallelism` against it.
const NS = 'f5-inbound-write';
const SITE = `${NS}-site`;
const USER = `${NS}-user`;
const SOURCE = `${NS}-source`;
const IMPORT = `${NS}-import`;

const SOURCE_NAME = 'F5 Probe Yard';
const SCOPE: PromotionScope = { siteId: SITE, from: '2026-06-01', to: '2026-06-30' };

const RESOLVER = inMemoryAliasResolver({
  [SOURCE_NAME]: {
    sourceId: SOURCE,
    siteId: SITE,
    canonicalName: SOURCE_NAME,
    isNonProgram: false,
  },
});

// Clears only the OPERATIONAL and IMPORT rows. The site, user and source are
// left standing and re-seeded idempotently by `seed()`.
//
// Hard rule #6 — the audit log is append-only and retained indefinitely; no
// code may delete or update an audit row, tests included. The promotion writes
// one, and `audit_log.actor_user_id` FKs to `users`, so deleting the fixture
// user would either fail on that FK or force an audit delete. Keeping the
// actor row alive is what lets this teardown obey the rule.
async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
  await d.$executeRawUnsafe(`DELETE FROM "workbook_promotions" WHERE "import_id" = '${IMPORT}'`);
  await d.$executeRawUnsafe(`DELETE FROM "workbook_import_rows" WHERE "import_id" = '${IMPORT}'`);
  await d.$executeRawUnsafe(`DELETE FROM "workbook_imports" WHERE "id" = '${IMPORT}'`);
}

const SITE_FIELDS = {
  code: NS,
  name: 'F5 Probe Site',
  jurisdiction: 'oregon' as const,
  mrc_program_code: 'MRC-OR-TEST',
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

async function seed(d: any): Promise<void> {
  await cleanup(d);
  await d.site.upsert({
    where: { id: SITE },
    update: {},
    create: { id: SITE, ...SITE_FIELDS },
  });
  await d.user.upsert({
    where: { id: USER },
    update: {},
    create: { id: USER, name: 'F5 Probe Uploader', role: 'admin', primary_site_id: SITE },
  });
  await d.source.upsert({
    where: { id: SOURCE },
    update: {},
    create: { id: SOURCE, site_id: SITE, name: SOURCE_NAME },
  });
  await d.workbookImport.create({
    data: {
      id: IMPORT,
      site_id: SITE,
      original_filename: 'f5-probe.xlsm',
      uploaded_by_user_id: USER,
    },
  });
  await d.workbookImportRow.create({
    data: {
      import_id: IMPORT,
      tab_name: 'Inbound',
      row_index: 4,
      col_ref: 'A',
      section: 'inbound',
      raw_value: JSON.stringify({ date: '2026-06-03', units: 25, slipNumber: 'S-9' }),
      site_name_raw: SOURCE_NAME,
      provenance: { tab: 'Inbound', row: 4, col: 'A' },
    },
  });
}

describe.skipIf(!REAL_DB)(
  'promoteWorkbookImport — inbound rows actually land (real client)',
  () => {
    beforeAll(async () => {
      const { PrismaClient: PC } = (await import('@prisma/client')) as {
        PrismaClient: typeof PrismaClient;
      };
      db = new PC({ datasources: { db: { url: REAL_DB! } } });
      await seed(db);
    });

    afterAll(async () => {
      if (db) {
        await cleanup(db);
        await db.$disconnect();
      }
    });

    it('promotes an inbound staging row into inbound_loads without a PrismaClientValidationError', async () => {
      // On the defective code this rejects with
      //   PrismaClientValidationError: Unknown argument `source`. Did you mean `source_id`?
      // and the whole $transaction rolls back.
      const res = await promoteWorkbookImport({
        db: db as PrismaClient,
        importId: IMPORT,
        scope: SCOPE,
        promotedByUserId: USER,
        resolver: RESOLVER,
      });

      expect(res.promoted).toBe(true);
      expect(res.counts.inbound_loads).toBe(1);

      // The row is asserted from the database, not from the return value — the
      // return value is computed before the write and would still be right if the
      // transaction had rolled back.
      const rows = await db.inboundLoad.findMany({ where: { site_id: SITE } });
      expect(rows).toHaveLength(1);
      expect(rows[0].total_units).toBe(25);
      expect(rows[0].slip_number).toBe('S-9');

      // ADR-0048: inbound promotion provenance rides on `import_id` ALONE. This is
      // the pair of assertions the deleted `source: 'import'` was trying to make —
      // `source_id` is the collection Source, `import_id` is the provenance.
      expect(rows[0].import_id).toBe(res.promotionId);
      expect(rows[0].source_id).toBe(SOURCE);
    });
  },
);
