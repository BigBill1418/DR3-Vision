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
    // A load the operator holds, counted and ready to file. `finished ->
    // submitted` is a legal edge; what must not happen is BOTH requests taking
    // it.
    //
    // ── VEHICLE CHANGED 2026-08-24 (ADR-0113) ────────────────────────────────
    //
    // This raced `rejectLoad` from `arrived`, because that was a `transition()`
    // caller. ADR-0113 rewrote `rejectLoad` onto `voidLoad`'s shape, so it no
    // longer goes through `transition()` at all — this test would have gone on
    // passing (once its fixture grew a rejection photo) while covering a
    // different function than this file's header describes and than its recorded
    // hand-falsification refers to. `submitLoad` is a `transition()` caller and
    // keeps ADR-0118's subject, its assertions and its falsification intact.
    //
    // `rejectLoad`'s own guard is raced in the sibling test below; the contract
    // it must meet is identical, which is the point.
    await db.inboundLoad.create({
      data: {
        id: LOAD,
        site_id: SITE,
        source_id: SOURCE,
        status: 'finished',
        arrived_at: new Date('2026-08-07T15:00:00.000Z'),
        assigned_operator_id: OPERATOR,
      },
    });

    const { submitLoad } = await import('@/lib/load-service');

    const settled = await Promise.allSettled([
      submitLoad({ loadId: LOAD, operatorUserId: OPERATOR, siteId: SITE }),
      submitLoad({ loadId: LOAD, operatorUserId: OPERATOR, siteId: SITE }),
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
    expect(row.status).toBe('submitted');

    // Hard rule #6, and the reason the guard has to be inside the transaction:
    // a refused transition must leave NO audit row. Two rows would mean the log
    // records a decision that was never made.
    const audits = await db.auditLog.findMany({
      where: { table_name: 'inbound_loads', row_id: LOAD, action: 'update' },
    });
    expect.soft(audits, 'a refused transition must leave no audit row').toHaveLength(1);
  });

  it('ADR-0113 — two racing REJECTIONS: one wins, one is refused, ONE load audit row', async () => {
    // `rejectLoad` no longer goes through `transition()` (ADR-0113 D2), so the
    // guard above does not cover it. It carries its own, adopted from ADR-0118
    // at the 2026-08-24 rebase (D13.2), and it must meet the same contract: one
    // winner, one 409 `illegal_transition`, one audit row on `inbound_loads`.
    //
    // Raced against a REAL Postgres for the reason this file's header gives: the
    // verdict is a `count` computed under a row lock, and a fake `updateMany`
    // returns whatever it was told to and cannot be raced.
    await db.inboundLoad.create({
      data: {
        id: LOAD,
        site_id: SITE,
        source_id: SOURCE,
        status: 'in_progress',
        arrived_at: new Date('2026-08-07T15:00:00.000Z'),
        unload_started_at: new Date('2026-08-07T15:12:00.000Z'),
        assigned_operator_id: OPERATOR,
      },
    });
    // ADR-0113 D3 — the rejection is refused server-side without evidence, so
    // the fixture has to carry the photo the floor would have taken. Its absence
    // is what made this file's first test go red on the rebase, and that was the
    // requirement working, not a fixture bug.
    await db.loadPhoto.create({
      data: {
        load_id: LOAD,
        kind: 'rejection',
        storage_key: `${NS}/rejection.jpg`,
        captured_at: new Date('2026-08-07T15:20:00.000Z'),
      },
    });
    // One counted stack, so the same-transaction sweep (D4) has something to do.
    await db.loadStack.create({
      data: { load_id: LOAD, stack_index: 1, unit_count: 12, count_mode: 'multiplier' },
    });

    const { rejectLoad } = await import('@/lib/load-service');
    const call = () =>
      rejectLoad({
        loadId: LOAD,
        operatorUserId: OPERATOR,
        siteId: SITE,
        category: 'bedbugs',
        note: null,
      });

    const settled = await Promise.allSettled([call(), call()]);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const refused = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect.soft(fulfilled, 'exactly one rejection may commit').toHaveLength(1);
    expect.soft(refused, 'the loser must be refused').toHaveLength(1);
    if (refused.length === 1) {
      const err = refused[0]!.reason as { status?: number; reason?: string };
      expect(err.status, 'the loser must surface as a 409, not a 500').toBe(409);
      expect(err.reason).toBe('illegal_transition');
    }

    const row = await db.inboundLoad.findUniqueOrThrow({ where: { id: LOAD } });
    expect(row.status).toBe('rejected');
    expect(row.rejection_category).toBe('bedbugs');
    // D5 — the slot is RETAINED, never severed. This fixture has no parent slot,
    // so the assertion that carries weight here is that the void's columns were
    // NOT written: a reject must not look like a void in the record.
    expect(row.voided_from_expected_load_id).toBeNull();

    // D4 — the counted stack is soft-voided by the winner, in the same commit.
    const stacks = await db.loadStack.findMany({ where: { load_id: LOAD } });
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.voided_at).not.toBeNull();
    expect(stacks[0]!.unit_count, 'a SOFT void keeps what was counted').toBe(12);

    // The refused racer must leave NO audit row: two would mean the log records
    // a rejection that never happened.
    const audits = await db.auditLog.findMany({
      where: { table_name: 'inbound_loads', row_id: LOAD, action: 'update' },
    });
    expect.soft(audits, 'a refused rejection must leave no audit row').toHaveLength(1);
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
