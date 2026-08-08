// ADR-0084 — the void, against a REAL Postgres.
//
// `void-count.test.ts` covers the logic against an in-memory evaluator, and it
// is a genuine falsification: strip `NOT_VOIDED` from `running-balance.ts` and
// it goes red naming the withdrawn count's total. What it CANNOT check is the
// two claims that are about the database rather than about the code:
//
//   1. **Postgres's own planner honours the filter in the anchor SELECT.** The
//      in-memory matcher is code I wrote; a green result there proves my matcher
//      agrees with my where-clause. Only the real engine, running the real
//      `WHERE voided_at IS NULL ... ORDER BY snapshot_at DESC, created_at DESC`
//      over the real composite index, proves the anchor actually moves.
//
//   2. **Two concurrent voids produce exactly ONE audit row.** The defence is a
//      `NOT_VOIDED`-guarded `updateMany` inside a transaction plus the ADR-0078
//      idempotency claim. Both are statements about transaction isolation and
//      row locking. A fake `$transaction` that just calls its callback cannot be
//      wrong about them — so a green fake is a restatement of the fixture.
//
// Runs in CI's `migrations` job, which stands up an ephemeral Postgres 16 and
// applies the whole migration chain (`npx vitest run --no-file-parallelism
// db.test.ts`). Skips silently anywhere DR3_TEST_DATABASE_URL is unset — which
// includes the operator control-plane host, where no Postgres is reachable.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// The service under test writes through the `@/lib/prisma` singleton
// (DATABASE_URL) while the assertions below read their own client
// (DR3_TEST_DATABASE_URL). If those addressed different databases the suite
// would write to one and check the other, and "the anchor moved" would be true
// for the boring reason. Same posture as `floor-exactly-once.db.test.ts`.
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'snapshot-void.db.test.ts: set DATABASE_URL to the same value as DR3_TEST_DATABASE_URL — ' +
      'otherwise the writes and the assertions address different databases.',
  );
}

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

const SITE = 'void-site';
const OP = 'void-operator';
const PRIOR = 'void-snap-prior';
const TODAY = 'void-snap-today';

/** Pacific midnight of the CURRENT Pacific day, computed by the app's own helper. */
async function pacificMidnightToday(): Promise<Date> {
  const { pacificDayStartInstant } = await import('@/lib/time');
  return pacificDayStartInstant(new Date());
}

let seq = 5000;
function key(): string {
  seq += 1;
  return `${Date.now().toString(36).padStart(13, '0')}-${String(seq).padStart(20, '0')}`;
}

async function seed(d: any): Promise<void> {
  const today = await pacificMidnightToday();
  const yesterday = new Date(today.getTime() - 86_400_000);

  await d.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "row_id" IN ('${PRIOR}','${TODAY}')`);
  await d.$executeRawUnsafe(`DELETE FROM "site_inventory_snapshots" WHERE "site_id" = '${SITE}'`);
  // Scoped to this file's actor, never a blanket truncate — the real-DB suites
  // share one database and run with `--no-file-parallelism` but not isolation.
  await d.$executeRawUnsafe(`DELETE FROM "idempotency_keys" WHERE "actor_user_id" = '${OP}'`);
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" ("id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at")
    VALUES ('${SITE}','voidt','Void Test','oregon','OR-V','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "users" ("id","name","role","primary_site_id","updated_at")
    VALUES ('${OP}','Void Operator','operator','${SITE}',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);

  // Yesterday's good anchor (2,000) and today's mistyped one (2,483) — the real
  // Woodland shape: a same-day re-entry replacing a known-good count.
  for (const [id, at, total] of [
    [PRIOR, yesterday, 2000],
    [TODAY, today, 2483],
  ] as const) {
    await d.$executeRawUnsafe(`
      INSERT INTO "site_inventory_snapshots"
        ("id","site_id","snapshot_at","created_at","snapshot_kind","units_total",
         "units_in_processing","pool_attribution","source")
      VALUES ('${id}','${SITE}','${at.toISOString()}','${at.toISOString()}',
              'physical',${total},0,'legacy','manual')`);
    // The provenance row `reconcilePhysicalCount` writes — `voidSnapshot`
    // resolves "who counted" from it, so without it the void is a 403.
    await d.$executeRawUnsafe(`
      INSERT INTO "audit_log" ("id","actor_user_id","action","table_name","row_id","created_at")
      VALUES ('audit-${id}','${OP}','insert','site_inventory_snapshots','${id}',CURRENT_TIMESTAMP)`);
  }
}

async function voidAuditCount(d: any, rowId: string): Promise<number> {
  const rows = await d.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "audit_log"
      WHERE "row_id" = '${rowId}' AND "action" = 'update'
        AND "table_name" = 'site_inventory_snapshots'`,
  );
  return (rows as Array<{ n: number }>)[0]?.n ?? 0;
}

describe.skipIf(!SAME_DB)('ADR-0084 — the void, in Postgres', () => {
  beforeEach(async () => {
    await seed(await connect());
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('the real anchor SELECT stops returning the voided count, and onHand drops to 2,000', async () => {
    const d = await connect();
    const { onHand } = await import('./running-balance');
    const { voidSnapshot } = await import('./void-count');

    expect((await onHand(SITE, new Date())).total.toString()).toBe('2483');

    await voidSnapshot({ snapshotId: TODAY, actorUserId: OP, siteId: SITE, idempotencyKey: null });

    // The engine's own answer, not Prisma's: the same predicate + ordering the
    // shipped selector uses, run as SQL.
    const anchor = (await d.$queryRawUnsafe(`
      SELECT "id","units_total" FROM "site_inventory_snapshots"
       WHERE "site_id" = '${SITE}' AND "snapshot_kind" = 'physical' AND "voided_at" IS NULL
       ORDER BY "snapshot_at" DESC, "created_at" DESC LIMIT 1`)) as Array<{
      id: string;
      units_total: number;
    }>;
    expect(anchor[0]?.id).toBe(PRIOR);
    expect(anchor[0]?.units_total).toBe(2000);

    // And the shipped code agrees with it. The EXACT prior-anchor value.
    expect((await onHand(SITE, new Date())).total.toString()).toBe('2000');

    // Never a hard delete — the withdrawn count is still there, stamped.
    const rows = (await d.$queryRawUnsafe(
      `SELECT "id","voided_at","voided_by" FROM "site_inventory_snapshots" WHERE "site_id" = '${SITE}'`,
    )) as Array<{ id: string; voided_at: Date | null; voided_by: string | null }>;
    expect(rows).toHaveLength(2);
    const voided = rows.find((r) => r.id === TODAY);
    expect(voided?.voided_at).not.toBeNull();
    expect(voided?.voided_by).toBe(OP);
  });

  it('two CONCURRENT voids of the same count write exactly ONE audit row', async () => {
    const { voidSnapshot } = await import('./void-count');
    const d = await connect();

    // Distinct keys on purpose: identical keys would be deduped by the
    // idempotency claim alone, which is already covered. Distinct keys force the
    // race onto the `NOT_VOIDED`-guarded `updateMany`, which is the defence that
    // only a real database can be wrong about.
    const results = await Promise.all([
      voidSnapshot({ snapshotId: TODAY, actorUserId: OP, siteId: SITE, idempotencyKey: key() }),
      voidSnapshot({ snapshotId: TODAY, actorUserId: OP, siteId: SITE, idempotencyKey: key() }),
    ]);

    // Both callers succeed — a void is idempotent, not a lottery.
    expect(results.every((r) => r.snapshotId === TODAY)).toBe(true);
    // Exactly one of them did the writing.
    expect(results.filter((r) => r.alreadyVoided === false)).toHaveLength(1);
    // An append-only log that grows a row per redundant tap stops being a record.
    expect(await voidAuditCount(d, TODAY)).toBe(1);
  });

  it('the DB refuses a half-written void (voided_by set, voided_at null)', async () => {
    // The migration's `site_inventory_snapshots_void_pair_chk`. Asserted here
    // because a CHECK constraint is exactly the kind of claim a fake prisma can
    // only be written to agree with.
    const d = await connect();
    await expect(
      d.$executeRawUnsafe(
        `UPDATE "site_inventory_snapshots" SET "voided_by" = '${OP}' WHERE "id" = '${TODAY}'`,
      ),
    ).rejects.toThrow();
  });
});
