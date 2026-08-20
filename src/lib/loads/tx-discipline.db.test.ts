// ADR-0118 — the eight high-severity siblings, against a REAL Postgres.
//
// The set is one rule applied in three shapes, and the two that carry money are
// the ones asserted here end to end:
//
//   1. `load-service.ts` `transition()` — the state machine's table was
//      consulted and then not enforced. `assertOwn` read the status on the
//      shared client; the write was an unguarded `update({ where: { id } })`
//      which succeeds whatever the row's status is by then. One load is
//      reachable from the shared kiosk, the operator's own iPad and the
//      offline-queue replay endpoint, so two requests routinely pass the same
//      check and both write. `load-claim.ts:372-376` names this exact defect.
//
//   2. `commodity-payments/payments.ts` — the invoiced -> paid flip, same
//      shape, on money. Two managers in the AP queue both read `invoiced`, both
//      pass `TRANSITIONS`, and both write: neither is refused, and the audit log
//      gains TWO rows each claiming to be the `invoiced->paid` transition, so
//      the record of who moved this money is ambiguous forever.
//
// Why a real database: both claims are about what happens when two writers race
// one row, and the verdict is a `count` Postgres computes under a row lock. A
// fake `updateMany` returns what it was written to return and cannot be raced.
//
// ── FALSIFIED BY HAND (2026-08-20) ───────────────────────────────────────────
//
// Restoring the unguarded `update` in `transition()` — the shape on `main` —
// lets both racers win:
//     → exactly one transition may succeed: expected [ … ] to have a length of 1 but got 2
//     → a refused transition must leave no audit row: expected 2 to be 1
//
// Restoring it in `payments.ts` likewise:
//     → exactly one manager may flip this load to paid: … to have a length of 1 but got 2
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'tx-discipline.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0118-txdisc';
const SITE = `${NS}-site`;
const OPERATOR = `${NS}-operator`;
const MANAGER = `${NS}-manager`;
const SOURCE = `${NS}-source`;

// A FRESH id per test: `audit_log` is append-only (hard rule #6) and this suite
// must never delete from it, so rows from earlier runs survive in a shared CI
// database. Counting audit rows against a FIXED id would fail on the second run.
let LOAD = '';
let OUTBOUND = '';

const SITE_FIELDS = {
  code: NS,
  name: 'DR3 Tx Discipline Probe',
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

async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(
    `DELETE FROM "outbound_material_payments" WHERE "outbound_material_id" IN
       (SELECT "id" FROM "outbound_materials" WHERE "site_id" = '${SITE}')`,
  );
  await d.$executeRawUnsafe(`DELETE FROM "outbound_materials" WHERE "site_id" = '${SITE}'`);
  await d.$executeRawUnsafe(`DELETE FROM "load_stacks" WHERE "load_id" LIKE '${NS}-load-%'`);
  await d.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
}

async function seed(d: any): Promise<void> {
  await cleanup(d);
  const stamp = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  LOAD = `${NS}-load-${stamp}`;
  OUTBOUND = `${NS}-outbound-${stamp}`;

  await d.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
  for (const [id, name, role] of [
    [OPERATOR, 'Tx Probe Operator', 'operator'],
    [MANAGER, 'Tx Probe Manager', 'manager'],
  ] as const) {
    await d.user.upsert({
      where: { id },
      update: {},
      create: { id, name, role, primary_site_id: SITE },
    });
  }
  await d.source.upsert({
    where: { id: SOURCE },
    update: {},
    create: { id: SOURCE, site_id: SITE, name: 'Tx Probe Yard' },
  });
}

describe.skipIf(!REAL_DB)('ADR-0118 — guarded state changes, audited in the same commit', () => {
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

  it('two racing transitions: one wins, one is refused, ONE audit row', async () => {
    // A load the operator holds, on the dock. `arrived -> rejected` is a legal
    // edge; what must not happen is BOTH requests taking it.
    await db.inboundLoad.create({
      data: {
        id: LOAD,
        site_id: SITE,
        source_id: SOURCE,
        status: 'arrived',
        arrived_at: new Date('2026-08-07T15:00:00.000Z'),
        assigned_operator_id: OPERATOR,
      },
    });

    const { rejectLoad } = await import('@/lib/load-service');

    const settled = await Promise.allSettled([
      rejectLoad({
        loadId: LOAD,
        operatorUserId: OPERATOR,
        siteId: SITE,
        category: 'bedbugs',
        note: null,
      }),
      rejectLoad({
        loadId: LOAD,
        operatorUserId: OPERATOR,
        siteId: SITE,
        category: 'bedbugs',
        note: null,
      }),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect.soft(fulfilled, 'exactly one transition may succeed').toHaveLength(1);
    expect.soft(rejected, 'the loser must be refused').toHaveLength(1);
    if (rejected.length === 1) {
      // The SAME typed error the pre-check raises, so every route that already
      // translates it keeps working and no raw enum reaches an operator.
      // `TransitionError` is module-private by design (ADR-0078 D11 documents
      // it as an internal typed error), so it is identified by the CONTRACT
      // `loadsErrorResponse` actually maps on — a numeric `status` and a
      // `reason` — rather than by exporting the class purely to satisfy a test.
      const err = rejected[0]!.reason as { status?: number; reason?: string };
      expect(err.status, 'the loser must surface as a 409, not a 500').toBe(409);
      expect(err.reason).toBe('illegal_transition');
    }

    const row = await db.inboundLoad.findUniqueOrThrow({ where: { id: LOAD } });
    expect(row.status).toBe('rejected');

    // Hard rule #6, and the reason the guard has to be inside the transaction:
    // a refused transition must leave NO audit row. Two rows would mean the log
    // records a decision that was never made.
    const audits = await db.auditLog.findMany({
      where: { table_name: 'inbound_loads', row_id: LOAD, action: 'update' },
    });
    expect.soft(audits, 'a refused transition must leave no audit row').toHaveLength(1);
  });

  it('two managers flipping one commodity load to paid: one wins, ONE audit row', async () => {
    await db.outboundMaterial.create({
      data: {
        id: OUTBOUND,
        site_id: SITE,
        ship_date: new Date(Date.UTC(2026, 6, 10)),
        commodity: 'metal',
        sub_category: 'baled',
        weight_lbs: 1000,
      },
    });
    await db.outboundMaterialPayment.create({
      data: {
        outbound_material_id: OUTBOUND,
        status: 'invoiced',
        invoiced_at: new Date(Date.UTC(2026, 6, 11)),
        created_by: MANAGER,
      },
    });

    const { upsertPaymentRecord, CommodityPaymentTransitionError } =
      await import('@/lib/commodity-payments/payments');

    const flip = () =>
      upsertPaymentRecord({
        outboundMaterialId: OUTBOUND,
        actorUserId: MANAGER,
        patch: { status: 'paid' },
      });

    const settled = await Promise.allSettled([flip(), flip()]);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect.soft(fulfilled, 'exactly one manager may flip this load to paid').toHaveLength(1);
    expect.soft(rejected).toHaveLength(1);
    if (rejected.length === 1) {
      expect(rejected[0]!.reason).toBeInstanceOf(CommodityPaymentTransitionError);
    }

    const payment = await db.outboundMaterialPayment.findFirstOrThrow({
      where: { outbound_material_id: OUTBOUND },
    });
    expect(payment.status).toBe('paid');
    expect(payment.paid_at, 'the winning flip must stamp its date').not.toBeNull();

    // The money record must name ONE transition. Two rows both claiming
    // `invoiced->paid` leaves who-moved-this-money ambiguous forever.
    const audits = await db.auditLog.findMany({
      where: { table_name: 'outbound_material_payments', row_id: payment.id },
    });
    expect.soft(audits, 'one money flip, one audit row').toHaveLength(1);
    expect((audits[0].after as { transition?: string }).transition).toBe('invoiced->paid');
  });
});
