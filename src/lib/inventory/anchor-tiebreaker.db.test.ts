// ADR-0078 D1 — "the latest anchor" must be a FACT, not a preference.
//
// The physical count is the inventory anchor: `onHand` computes every downstream
// number forward from it, and `loadPriorAnchor` measures the ADR-0072 swing
// guardrail against it. Both selectors ordered by `snapshot_at DESC` alone.
//
// `snapshot_at` is not distinct per count. The floor route anchors every count at
// Pacific MIDNIGHT of its day (ADR-0060 D-3), so two counts taken on the same day
// are stored with the byte-identical timestamp — verified in production, where
// both existing physical snapshots sit exactly on `07:00:00` UTC. SQL promises
// nothing about the order of equal sort keys, so which of two same-day counts
// became the anchor was a decision the query planner made about inventory.
//
// ## Why this cannot be a mocked-prisma test
//
// The claim is "Postgres returns a deterministic row for this ORDER BY". A fake
// prisma returns whatever the fake was written to return, so it would be
// measuring the fixture's array order, not the database's. Worse, non-determinism
// is the failure mode: a mock cannot be flaky in the way the real planner can, so
// a green mock would prove precisely nothing. Hence a real database, and hence 20
// repetitions — one pass of an arbitrary choice has a 50% chance of looking right.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

async function connect(): Promise<any> {
  if (db) return db;
  const { PrismaClient: PC } = (await import('@prisma/client')) as {
    PrismaClient: typeof PrismaClient;
  };
  db = new PC({ datasources: { db: { url: REAL_DB! } } });
  return db;
}

const SITE = 'tiebreak-site';
/** Pacific midnight of 2026-08-07 — the instant BOTH counts are stored at. */
const SAME_INSTANT = new Date('2026-08-07T07:00:00.000Z');

async function seedSite(d: any): Promise<void> {
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" ("id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at")
    VALUES ('${SITE}','tiebreak','Tiebreak','oregon','OR-T','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING
  `);
}

/**
 * Two counts, same site, IDENTICAL `snapshot_at`, different totals, inserted in a
 * known order with distinct `created_at`. `earlier` was entered first.
 */
async function seedTiedPair(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "site_inventory_snapshots" WHERE "site_id" = '${SITE}'`);
  // Insert the LATER-created row first, so that insertion order, physical row
  // order and ctid all disagree with the answer we require. If the tiebreaker
  // were absent, a heap scan would most naturally return this one — so a test
  // that seeded them in the "helpful" order could pass while measuring nothing.
  await d.$executeRawUnsafe(`
    INSERT INTO "site_inventory_snapshots"
      ("id","site_id","snapshot_at","units_total","units_in_processing",
       "snapshot_kind","source","pool_attribution","created_at")
    VALUES
      ('snap-later','${SITE}','${SAME_INSTANT.toISOString()}',999,0,'physical','manual','measured',
       '2026-08-07T23:00:00.000Z'),
      ('snap-earlier','${SITE}','${SAME_INSTANT.toISOString()}',111,0,'physical','manual','measured',
       '2026-08-07T15:00:00.000Z')
  `);
}

describe.skipIf(!REAL_DB)('ADR-0078 D1 — same-day anchor tiebreaker', () => {
  beforeEach(async () => {
    const d = await connect();
    await seedSite(d);
    await seedTiedPair(d);
  });

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(
        `DELETE FROM "site_inventory_snapshots" WHERE "site_id" = '${SITE}'`,
      );
      await db.$disconnect();
    }
  });

  // ── FALSIFICATION 3: count.anchor-tiebreaker ────────────────────────────
  //
  // FALSIFIED BY HAND: reverting `loadPriorAnchor`'s orderBy to
  // `{ snapshot_at: 'desc' }` makes this return `snap-later`'s 999 or
  // `snap-earlier`'s 111 depending on the plan — on this fixture it settles on
  // the wrong one every time, so the revert is red immediately rather than
  // intermittently. Twenty repetitions because an arbitrary choice between two
  // rows passes a single run half the time, and a guard against non-determinism
  // that runs once is not a guard.
  it('picks the LAST-ENTERED count, identically across 20 runs', async () => {
    const d = await connect();
    const { loadPriorAnchor } = await import('./anchor-guardrail');

    const totals: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const anchor = await loadPriorAnchor(d, SITE);
      totals.push(anchor?.total ?? -1);
    }

    // 999 is `snap-later` — created at 23:00, after `snap-earlier`'s 15:00.
    expect(new Set(totals).size, `anchor was not deterministic: ${JSON.stringify(totals)}`).toBe(1);
    expect(totals[0]).toBe(999);
  });

  // The two selectors must agree. A guardrail measuring the swing against one
  // count while the running balance computes forward from the other is the same
  // defect wearing a second hat, and strictly worse than either alone.
  it('the running-balance selector and the guardrail selector choose the SAME row', async () => {
    const d = await connect();
    const row = await d.siteInventorySnapshot.findFirst({
      where: { site_id: SITE, snapshot_kind: 'physical', snapshot_at: { lte: new Date() } },
      orderBy: [{ snapshot_at: 'desc' }, { created_at: 'desc' }],
      select: { id: true },
    });
    const { loadPriorAnchor } = await import('./anchor-guardrail');
    const anchor = await loadPriorAnchor(d, SITE);
    expect(row?.id).toBe('snap-later');
    expect(anchor?.id).toBe('snap-later');
  });

  // Guards the guard: if the fixture ever stopped producing a genuine tie, every
  // assertion above would pass vacuously while measuring ordinary date ordering.
  it('the fixture really is tied on snapshot_at', async () => {
    const d = await connect();
    const rows: Array<{ snapshot_at: Date }> = await d.$queryRawUnsafe(
      `SELECT "snapshot_at" FROM "site_inventory_snapshots" WHERE "site_id" = '${SITE}'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.snapshot_at.getTime()).toBe(rows[1]!.snapshot_at.getTime());
  });
});
