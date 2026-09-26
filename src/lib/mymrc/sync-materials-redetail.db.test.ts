// 2026-09-25 — the processed / outbound mirrors re-read a recent record once a
// day, against a REAL Postgres.
//
// The unit suite asserts the Prisma `where` shape. That proves what the adapter
// ASKS for, not what Postgres RETURNS for it — NULL semantics, the timestamp
// comparisons and the nested OR are the database's to evaluate. So this suite
// seeds four rows per feed (never detailed / recent + a day old / recent +
// freshly detailed / outside the window), runs the real `syncFeed`, and asserts
// (a) exactly which ids the detail transport was asked for, and (b) that MRC's
// corrected figure replaced the stored one through the normal detail path.
//
// ── FALSIFIED BY HAND (2026-09-25) ───────────────────────────────────────────
// Reverting `materialsRedetailWhere` to the pre-fix `detail_fetched_at: null`
// drops the recent-stale id from the request and leaves the old units standing:
//     → expected [ 'rd-p-never' ] to deeply equal [ 'rd-p-never', 'rd-p-stale' ]
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { PortalClient } from './portal-client';
import type { RecordFieldsClient } from './record-fields-client';
import type { SfRecord } from './types';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
const NS = 'rd';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let siteId: string;
let createdSite = false;

type Feed = 'processed' | 'outbound';
const TABLE: Record<Feed, string> = {
  processed: 'mymrc_processed_mirror',
  outbound: 'mymrc_outbound_mirror',
};
const DATE_COL: Record<Feed, string> = {
  processed: 'processed_date',
  outbound: 'shipment_date',
};
const TYPE: Record<Feed, string> = { processed: 'Processing', outbound: 'Outbound' };
const p = (feed: Feed): string => (feed === 'processed' ? 'p' : 'o');

async function cleanup(d: any): Promise<void> {
  for (const t of Object.values(TABLE)) {
    await d.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "id" LIKE '${NS}-%'`);
  }
  await d.$executeRawUnsafe(`DELETE FROM "mymrc_sync_runs" WHERE "run_id" LIKE '${NS}-%'`);
}

/** One mirror row, dated `businessAgo` back, last detailed `detailAgo` back (null = never). */
async function seedRow(
  d: any,
  feed: Feed,
  id: string,
  businessAgo: number,
  detailAgo: number | null,
  units: number,
): Promise<void> {
  const day = ago(businessAgo).toISOString();
  const detail = detailAgo === null ? 'NULL' : `'${ago(detailAgo).toISOString()}'`;
  await d.$executeRawUnsafe(`
    INSERT INTO "${TABLE[feed]}"
      ("id","site_id","type","entry_date","${DATE_COL[feed]}","program_unit_count",
       "detail_fetched_at","first_seen_at","last_seen_at","created_at","updated_at")
    VALUES ('${id}','${siteId}','${TYPE[feed]}','${day}','${day}',${units},
            ${detail}, now(), now(), now(), now())
  `);
}

/** What MRC now says about a record: the corrected unit count. */
function mrcRecord(feed: Feed, id: string, units: number): SfRecord {
  const day = ago(5 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return {
    apiName: 'Materials__c',
    id,
    fields: {
      Name: { displayValue: null, value: `M-${id}` },
      Type__c: { displayValue: null, value: TYPE[feed] },
      Account__r: {
        displayValue: 'DR3 Woodland',
        value: {
          apiName: 'Account',
          id: 'acc-w',
          fields: { Name: { displayValue: null, value: 'DR3 Woodland' } },
        },
      },
      Entry_Date__c: { displayValue: null, value: day },
      Processed_Date__c: { displayValue: null, value: day },
      Shipment_Date__c: { displayValue: null, value: day },
      Number_of_Program_Units__c: { displayValue: null, value: units },
    },
  };
}

describe.skipIf(!REAL_DB)('processed/outbound mirrors re-read recent records (real DB)', () => {
  beforeAll(async () => {
    const { PrismaClient: PC } = (await import('@prisma/client')) as {
      PrismaClient: typeof PrismaClient;
    };
    db = new PC({ datasources: { db: { url: REAL_DB! } } });
    const existing = await db.site.findUnique({ where: { code: 'woodland' } });
    if (existing) {
      siteId = existing.id;
    } else {
      siteId = `${NS}-woodland`;
      createdSite = true;
      await db.site.create({
        data: {
          id: siteId,
          code: 'woodland',
          name: 'DR3 Woodland (redetail probe)',
          jurisdiction: 'california',
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
          billing_cadence: 'end_of_month_only',
        },
      });
    }
    await cleanup(db);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup(db);
    if (createdSite) await db.site.delete({ where: { id: siteId } });
    await db.$disconnect();
  });

  it.each(['processed', 'outbound'] as const)(
    '%s: re-reads the recent, day-old row and lands MRC’s correction',
    async (feed) => {
      const id = (s: string): string => `${NS}-${p(feed)}-${s}`;
      await seedRow(db, feed, id('never'), 3 * DAY_MS, null, 0);
      await seedRow(db, feed, id('stale'), 5 * DAY_MS, 25 * 60 * 60 * 1000, 6020);
      await seedRow(db, feed, id('fresh'), 5 * DAY_MS, 2 * 60 * 60 * 1000, 70);
      await seedRow(db, feed, id('old'), 60 * DAY_MS, 25 * 60 * 60 * 1000, 80);
      const listed = ['never', 'stale', 'fresh', 'old'].map(id);

      const requested: string[] = [];
      const recordFields: RecordFieldsClient = {
        fetchRecordFields: vi.fn(async (ids: readonly string[]) => {
          requested.push(...ids);
          return {
            records: new Map(ids.map((i) => [i, mrcRecord(feed, i, 136)])),
            errors: [],
          };
        }),
      };
      const client = {
        fetchListRecordIds: vi.fn(async () => ({ ids: listed, complete: false })),
        getSession: vi.fn(),
        close: vi.fn(async () => undefined),
      } as unknown as PortalClient;

      const { syncFeed } = await import('./sync');
      await syncFeed({
        prisma: db,
        client,
        recordFields,
        site: 'woodland',
        feed,
        pager: { page: async () => undefined },
        now: () => NOW,
        runId: `${NS}-${feed}`,
      });

      expect([...requested].sort()).toEqual([id('never'), id('stale')].sort());
      const units = async (s: string): Promise<number> =>
        (
          await db.$queryRawUnsafe(
            `SELECT program_unit_count AS n FROM "${TABLE[feed]}" WHERE id = '${id(s)}'`,
          )
        )[0].n;
      expect(await units('stale'), 'MRC’s correction must reach the mirror').toBe(136);
      expect(await units('fresh'), 'a row detailed <24 h ago is not re-read').toBe(70);
      expect(await units('old'), 'a row outside the 45-day window is not re-read').toBe(80);
    },
  );
});
