// ADR-0118 — releasing a held count is ONE transaction, against a REAL Postgres.
//
// Two claims, and neither survives a mocked client.
//
//   1. TWO MANAGERS CANNOT RELEASE ONE HOLD TWICE. ADR-0072 deliberately built
//      two release paths — the on-device PIN and the remote manager screen —
//      and before this change both read `status === 'pending'` and both wrote a
//      `physical` snapshot. One counted event, two anchors, and (per ADR-0078
//      D1's `created_at DESC` tiebreak) the second silently becomes the floor's
//      inventory anchor. The guard is a `updateMany` whose `count` is the
//      verdict; only Postgres's row lock can decide it, so only Postgres can
//      test it. A fake `updateMany` returns what it was written to return and
//      cannot be raced at all.
//
//   2. PASSING `tx` ACTUALLY ENLISTS THE WRITE. This is the load-bearing
//      property of the whole change, here and in the anchor-reactivation route:
//      if the snapshot were still opening its own transaction, a failure in the
//      audit row afterwards would leave a live anchor standing with nothing
//      recording where it came from. The only way to prove enlistment is to
//      roll the caller's transaction back and look — and a mock cannot roll
//      back, because it never committed anything.
//
// ── FALSIFIED BY HAND (2026-08-19) ───────────────────────────────────────────
//
// Test 1: reverting `releaseHold` to the pre-fix sequence (reconcile first, then
// an unguarded `update` to `approved`) makes both racers succeed and writes TWO
// snapshots — `expected 2 to be 1` on the snapshot count.
//
// Test 2: dropping the `tx` argument from the `reconcilePhysicalCount` call —
// the exact pre-fix shape of the reactivation route — leaves the snapshot
// standing after the enclosing transaction throws: `expected 1 to be 0`.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0118-holds';
const SITE = `${NS}-site`;
const OPERATOR = `${NS}-operator`;
const MANAGER = `${NS}-manager`;

const SITE_FIELDS = {
  code: NS,
  name: 'DR3 Hold Release Probe',
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

// Clears the OPERATIONAL rows only. The site and both users stay standing —
// CLAUDE.md hard rule #6 makes the audit log append-only, and
// `audit_log.actor_user_id` FKs to `users`, so deleting the actors would either
// fail on that FK or force an audit delete.
async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "inventory_count_holds" WHERE "site_id" = '${SITE}'`);
  await d.$executeRawUnsafe(`DELETE FROM "site_inventory_snapshots" WHERE "site_id" = '${SITE}'`);
}

async function seed(d: any): Promise<void> {
  await cleanup(d);
  await d.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
  await d.user.upsert({
    where: { id: OPERATOR },
    update: {},
    create: { id: OPERATOR, name: 'Hold Probe Operator', role: 'operator', primary_site_id: SITE },
  });
  await d.user.upsert({
    where: { id: MANAGER },
    update: {},
    create: { id: MANAGER, name: 'Hold Probe Manager', role: 'manager', primary_site_id: SITE },
  });
}

/** A pending Tier-2 hold entered by the operator, awaiting a manager release. */
async function seedPendingHold(d: any): Promise<string> {
  const hold = await d.inventoryCountHold.create({
    data: {
      site_id: SITE,
      units_total: 2_400,
      units_in_processing: 0,
      program_units: 2_400,
      non_program_units: 0,
      pool_attribution: 'measured',
      prior_total: 1_000,
      new_total: 2_400,
      swing_pct: 140,
      threshold_pct: 25,
      status: 'pending',
      created_by: OPERATOR,
    },
    select: { id: true },
  });
  return hold.id;
}

const livePhysicalCount = async (d: any): Promise<number> =>
  d.siteInventorySnapshot.count({
    where: { site_id: SITE, snapshot_kind: 'physical', voided_at: null },
  });

describe.skipIf(!REAL_DB)('ADR-0118 — the held-count release is one transaction', () => {
  beforeEach(async () => {
    if (!db) {
      const { PrismaClient: PC } = (await import('@prisma/client')) as {
        PrismaClient: typeof PrismaClient;
      };
      db = new PC({ datasources: { db: { url: REAL_DB! } } });
    }
    await seed(db);
  });

  afterAll(async () => {
    if (db) {
      await cleanup(db);
      await db.$disconnect();
    }
  });

  it('two managers releasing the SAME hold write exactly one anchor', async () => {
    const holdId = await seedPendingHold(db);
    const { releaseHold, HoldNotPendingError } = await import('./anchor-holds');

    // The two ADR-0072 paths, raced. `remote` on both because the PIN path adds
    // an Argon2id verification that is not what this test is about; the rule
    // under test lives below both of them and does not branch on `path`.
    const settled = await Promise.allSettled([
      releaseHold(db, { holdId, approverUserId: MANAGER, path: 'remote' }),
      releaseHold(db, { holdId, approverUserId: MANAGER, path: 'remote' }),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled, 'exactly one release may succeed').toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser must be told WHICH state won, not handed a bare conflict the
    // route cannot translate into operator copy.
    expect(rejected[0]!.reason).toBeInstanceOf(HoldNotPendingError);
    expect((rejected[0]!.reason as Error).message).toBe('hold_approved');

    // The assertion that matters, read from the database rather than from the
    // return values: ONE live physical anchor exists for this site. Pre-fix
    // this is 2, and the later of the two silently becomes the floor's anchor.
    expect(await livePhysicalCount(db), 'one counted event must produce one anchor').toBe(1);

    // The hold points at the anchor that was actually written, and is approved
    // exactly once.
    const hold = await db.inventoryCountHold.findUnique({ where: { id: holdId } });
    expect(hold.status).toBe('approved');
    expect(hold.resulting_snapshot_id).not.toBeNull();
    const snap = await db.siteInventorySnapshot.findUnique({
      where: { id: hold.resulting_snapshot_id },
    });
    expect(snap, 'the hold must not point at a snapshot that never committed').not.toBeNull();

    // Hard rule #6 — the release is audited, exactly once.
    const rows = await db.auditLog.findMany({
      where: { table_name: 'inventory_count_holds', row_id: holdId, action: 'update' },
    });
    expect(rows).toHaveLength(1);
  });

  it('a snapshot written on the caller transaction rolls back with it', async () => {
    // This is the anchor-reactivation route's property, isolated: the audit row
    // it writes after the snapshot is the ONLY thing distinguishing a
    // re-anchor from a count somebody took, so the two must share a commit.
    // Written against `reconcilePhysicalCount` directly because that is the
    // seam both call sites go through.
    const { reconcilePhysicalCount } = await import('./running-balance');

    expect(await livePhysicalCount(db)).toBe(0);

    const boom = new Error('audit row failed');
    await expect(
      db.$transaction(async (tx: any) => {
        await reconcilePhysicalCount({
          siteId: SITE,
          countedAt: new Date('2026-08-07T07:00:00.000Z'),
          physical: { units_total: 1_234, units_in_processing: 0 },
          programUnits: 1_234,
          nonProgramUnits: 0,
          poolAttribution: 'measured',
          actorUserId: MANAGER,
          tx,
        });
        // Stands in for the audit write failing after the snapshot landed.
        throw boom;
      }),
    ).rejects.toThrow('audit row failed');

    // Pre-fix — with the `tx` argument dropped, which is exactly what the
    // reactivation route did — the snapshot opens its own transaction, commits
    // independently, and survives this rollback as a live anchor with no
    // provenance. That reads as `expected 1 to be 0`.
    expect(
      await livePhysicalCount(db),
      'the snapshot must not survive the transaction that wrote it',
    ).toBe(0);
  });
});
