// ADR-0085 — the walk-up drop-off's money, PII, photo and inventory guarantees,
// proven against a REAL Postgres.
//
// ## Why a mocked Prisma is disqualified here
//
// Every claim in this file is a claim about the DATABASE:
// `consumer_dropoffs_floor_no_money_or_pii` refusing an INSERT,
// `consumer_dropoffs_floor_requires_photo` refusing another, `onHand`'s
// `SUM(units)` reaching the program pool through a `WHERE` clause nobody has
// taught about the new enum values. A fake prisma cannot exhibit a CHECK
// constraint; it can only be written to agree that one exists — which is the
// mock enforcing the rule the test claims to be checking, the failure this
// codebase has shipped more than once and the one the 2026-08-07 wave hit four
// separate times.
//
// The existing `running-balance.test.ts` shows exactly why it matters: its DB
// adapter stubs `store.dropoffs = { units: 10 }` and therefore never exercises
// the `where` clause at all. It would stay green if somebody added a `kind`
// filter to `onHand` tomorrow and silently dropped every walk-up drop-off out of
// inventory. This file closes that hole for the new kinds.
//
// So: a real database, or the suite skips. `DR3_TEST_DATABASE_URL` points at a
// Postgres with the migration chain applied — CI's `migrations` job stands one
// up (postgres:16-alpine + `prisma migrate deploy`) and runs this file against it.
//
// Locally: docker run --rm -e POSTGRES_PASSWORD=dr3 -e POSTGRES_USER=dr3 \
//   -e POSTGRES_DB=dr3_test -p 55471:5432 postgres:16-alpine
//   DATABASE_URL=… npx prisma migrate deploy
//   DR3_TEST_DATABASE_URL=postgresql://dr3:dr3@127.0.0.1:55471/dr3_test npm test

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createFloorDropoff } from './floor-dropoff';
import { UNPAID_DROPOFF_CENTS_PER_UNIT } from './service';

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

const SITE = 'site-adr0085';
const USER = 'user-adr0085';
const DAY = '2026-08-08';

async function seed(): Promise<void> {
  const d = await connect();
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" (
      "id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at"
    ) VALUES (
      '${SITE}','adr0085','ADR-0085 Test','oregon','TEST',
      '08:00','17:00',75.00,3,30,2,2,60,98.00,'end_of_month_only',CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "users" ("id","name","role","updated_at")
    VALUES ('${USER}','ADR-0085 Operator','operator',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
}

/** Raw INSERT so a test can present a row the application layer would never build. */
function rawInsert(cols: Record<string, string>): Promise<unknown> {
  const keys = Object.keys(cols);
  return db.$executeRawUnsafe(
    `INSERT INTO "consumer_dropoffs" (${keys.map((k) => `"${k}"`).join(',')},"updated_at")
     VALUES (${keys.map((k) => cols[k]).join(',')},CURRENT_TIMESTAMP)`,
  );
}

const suite = REAL_DB ? describe : describe.skip;

suite('ADR-0085 — floor drop-off (real Postgres)', () => {
  beforeEach(async () => {
    await seed();
    await db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "table_name" = 'consumer_dropoffs'`);
    await db.$executeRawUnsafe(`DELETE FROM "consumer_dropoffs" WHERE "site_id" = '${SITE}'`);
    await db.$executeRawUnsafe(`DELETE FROM "processed_units_daily" WHERE "site_id" = '${SITE}'`);
    await db.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Money + PII
  // ───────────────────────────────────────────────────────────────────────

  it('writes NULL money and NULL name for both label-only kinds', async () => {
    for (const kind of ['floor_public', 'floor_incentive'] as const) {
      await db.$transaction((tx: any) =>
        createFloorDropoff({
          tx,
          siteId: SITE,
          dropoffDate: DAY,
          kind,
          units: 4,
          photo: { storageKey: `dropoffs/${SITE}/x.jpg`, contentType: 'image/jpeg', byteSize: 11 },
          actorUserId: USER,
        }),
      );
    }

    const rows = await db.consumerDropoff.findMany({ where: { site_id: SITE } });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // The whole point of the feature, asserted field by field rather than as a
      // single "no money" spot-check — `incentive_cents` and
      // `incentive_amount_cents` are two DIFFERENT money columns and the old
      // default only ever populated the second.
      expect(r.incentive_cents, `${r.kind} wrote incentive_cents`).toBeNull();
      expect(r.incentive_amount_cents, `${r.kind} wrote incentive_amount_cents`).toBeNull();
      expect(r.person_name, `${r.kind} wrote person_name (CIP PII)`).toBeNull();
      expect(r.consumer_name, `${r.kind} wrote consumer_name (CIP PII)`).toBeNull();
      expect(r.check_number).toBeNull();
      expect(r.paid_at).toBeNull();
      // And the evidence IS recorded, attributed to the submitting session.
      expect(r.photo_storage_key).toBe(`dropoffs/${SITE}/x.jpg`);
      expect(r.photo_uploaded_by).toBe(USER);
    }
  });

  it('FALSIFICATION — forcing the pre-ADR money default onto a floor row is REFUSED', async () => {
    // This is the exact row the un-fixed `defaultIncentiveAmountCents` would have
    // produced: `kind` is not `incentive`, so it fell through to units × 300¢.
    // Four units at the Bye-Bye-Mattress rate is 1200¢ — $12 of check money on a
    // walk-up Bill said records none.
    const minted = 4 * UNPAID_DROPOFF_CENTS_PER_UNIT;
    expect(minted).toBe(1200);

    // Deliberately NOT `.rejects.toThrow(…)` alone. That asserts only that
    // SOMETHING refused, and when the guard is removed it reports
    // `promise resolved "1" instead of rejecting` — a message that names neither
    // the column nor the amount, so a reader cannot tell a money leak from a
    // typo'd table name. Attempt it, then READ THE ROW BACK: with the constraint
    // gone the failure says "expected 1200 to be null", which is the defect in
    // the operator's own units.
    const outcome = await rawInsert({
      id: `'money-falsification'`,
      site_id: `'${SITE}'`,
      dropoff_date: `DATE '${DAY}'`,
      kind: `'floor_public'`,
      units: '4',
      photo_storage_key: `'dropoffs/${SITE}/x.jpg'`,
      incentive_amount_cents: String(minted),
    }).then(
      () => 'ACCEPTED',
      (e: unknown) => String(e),
    );

    const written = await db.consumerDropoff.findUnique({
      where: { id: 'money-falsification' },
      select: { kind: true, incentive_amount_cents: true, incentive_cents: true },
    });
    expect(
      written?.incentive_amount_cents ?? null,
      'a floor_public drop-off was persisted carrying Bye-Bye-Mattress check money',
    ).toBeNull();
    expect(written, 'the money-bearing floor row was accepted at all').toBeNull();
    expect(outcome).toMatch(/consumer_dropoffs_floor_no_money_or_pii/);
  });

  it('FALSIFICATION — a name on a floor row is REFUSED (CIP PII stays out)', async () => {
    const outcome = await rawInsert({
      id: `'pii-falsification'`,
      site_id: `'${SITE}'`,
      dropoff_date: `DATE '${DAY}'`,
      kind: `'floor_incentive'`,
      units: '2',
      photo_storage_key: `'dropoffs/${SITE}/x.jpg'`,
      person_name: `'Jane Doe'`,
    }).then(
      () => 'ACCEPTED',
      (e: unknown) => String(e),
    );

    // Read back, so a regression reports the NAME that was stored rather than a
    // bare "did not reject". `person_name` is MRC Personal Data (Exhibit I /
    // ADR-0010) — a leak here carries breach-notification scope, and the test
    // that catches it should say whose name got in.
    const written = await db.consumerDropoff.findUnique({
      where: { id: 'pii-falsification' },
      select: { person_name: true },
    });
    expect(
      written?.person_name ?? null,
      'a floor drop-off was persisted carrying CIP PII (person_name)',
    ).toBeNull();
    expect(outcome).toMatch(/consumer_dropoffs_floor_no_money_or_pii/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Photo required
  // ───────────────────────────────────────────────────────────────────────

  it('FALSIFICATION — photo-less submit is refused with the client check STRIPPED', async () => {
    // The client's disabled Send button and the route's zod schema are both
    // upstream of here. This calls the service directly — the shape a stale
    // bundle or a hand-rolled POST produces once those are past — and then goes
    // one layer lower still.
    await expect(
      db.$transaction((tx: any) =>
        createFloorDropoff({
          tx,
          siteId: SITE,
          dropoffDate: DAY,
          kind: 'floor_public',
          units: 3,
          photo: { storageKey: '  ', contentType: 'image/jpeg', byteSize: 1 },
          actorUserId: USER,
        }),
      ),
    ).rejects.toThrow(/photo is required/i);

    // …and the storage layer refuses it independently, so removing the service
    // guard above does not open the hole either.
    const outcome = await rawInsert({
      id: `'photoless-falsification'`,
      site_id: `'${SITE}'`,
      dropoff_date: `DATE '${DAY}'`,
      kind: `'floor_public'`,
      units: '3',
    }).then(
      () => 'ACCEPTED',
      (e: unknown) => String(e),
    );
    const written = await db.consumerDropoff.findUnique({
      where: { id: 'photoless-falsification' },
      select: { kind: true, units: true, photo_storage_key: true },
    });
    expect(
      written,
      'a floor drop-off with NO photo was persisted — the evidence requirement is gone',
    ).toBeNull();
    expect(outcome).toMatch(/consumer_dropoffs_floor_requires_photo/);

    expect(await db.consumerDropoff.count({ where: { site_id: SITE } })).toBe(0);
  });

  it('the manager kinds still REQUIRE a name — the nullable column did not open a hole', async () => {
    // `person_name` went from NOT NULL to nullable in this migration. That is a
    // loosening, and an unscoped loosening is just a hole: without
    // `consumer_dropoffs_non_floor_requires_person`, a manager drop-off could
    // now be written with no payee and the per-person daily cap would have
    // nothing to aggregate by.
    const outcome = await rawInsert({
      id: `'nameless-unpaid'`,
      site_id: `'${SITE}'`,
      dropoff_date: `DATE '${DAY}'`,
      kind: `'unpaid'`,
      units: '5',
    }).then(
      () => 'ACCEPTED',
      (e: unknown) => String(e),
    );
    const written = await db.consumerDropoff.findUnique({
      where: { id: 'nameless-unpaid' },
      select: { kind: true, person_name: true },
    });
    expect(
      written,
      'an anonymous MANAGER drop-off was persisted — the old NOT NULL invariant is gone',
    ).toBeNull();
    expect(outcome).toMatch(/consumer_dropoffs_non_floor_requires_person/);
  });

  it('anonymous floor rows are invisible to the per-person daily cap', async () => {
    // The cap aggregates `WHERE person_name = <name>`. In SQL nothing equals
    // NULL, so an anonymous walk-up cannot consume a named collector's daily
    // allowance — which would silently UNDER-PAY them. Asserted against the real
    // query rather than reasoned about.
    await db.$transaction((tx: any) =>
      createFloorDropoff({
        tx,
        siteId: SITE,
        dropoffDate: DAY,
        kind: 'floor_incentive',
        units: 40,
        photo: { storageKey: `dropoffs/${SITE}/x.jpg`, contentType: 'image/jpeg', byteSize: 1 },
        actorUserId: USER,
      }),
    );
    const priors = await db.consumerDropoff.findMany({
      where: { site_id: SITE, person_name: 'Real Collector', dropoff_date: new Date(`${DAY}T00:00:00Z`) },
      select: { incentive_cents: true },
    });
    expect(priors, '40 anonymous units leaked into a named collector’s cap').toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Inventory: contributes once, and only through its own leg
  // ───────────────────────────────────────────────────────────────────────

  it('reaches the PROGRAM pool through the real kind-blind aggregate', async () => {
    // `onHand` sums `consumer_dropoffs.units` with NO `kind` filter. That is what
    // makes the new enum values reach inventory with no aggregation taught about
    // them — and it is exactly the property `running-balance.test.ts` cannot see,
    // because it stubs the aggregate. Run against the real WHERE clause.
    await db.$transaction((tx: any) =>
      createFloorDropoff({
        tx,
        siteId: SITE,
        dropoffDate: DAY,
        kind: 'floor_public',
        units: 7,
        photo: { storageKey: `dropoffs/${SITE}/a.jpg`, contentType: 'image/jpeg', byteSize: 1 },
        actorUserId: USER,
      }),
    );
    const agg = await db.consumerDropoff.aggregate({
      _sum: { units: true },
      where: { site_id: SITE, dropoff_date: { gt: new Date('2026-08-01'), lte: new Date('2026-08-31') } },
    });
    expect(agg._sum.units).toBe(7);
  });

  it('NO DOUBLE-COUNT — writes only consumer_dropoffs, never a second inbound leg', async () => {
    // The double-count risk here was never the enum: every inventory aggregation
    // is kind-blind, so a new kind cannot be silently excluded. The risk is
    // writing the same physical mattresses into a SECOND leg — `onHand` adds
    // `inbound_loads` and `consumer_dropoffs` with no dedup between them, which
    // is precisely why `mymrc/inbound-bridge.ts` excludes `type='Consumer Dropoff'`.
    await db.$transaction((tx: any) =>
      createFloorDropoff({
        tx,
        siteId: SITE,
        dropoffDate: DAY,
        kind: 'floor_incentive',
        units: 9,
        photo: { storageKey: `dropoffs/${SITE}/b.jpg`, contentType: 'image/jpeg', byteSize: 1 },
        actorUserId: USER,
      }),
    );

    expect(
      await db.inboundLoad.count({ where: { site_id: SITE } }),
      'the drop-off also wrote an inbound_loads row — those units now count twice',
    ).toBe(0);
    expect(
      await db.processedUnitsDaily.count({ where: { site_id: SITE } }),
      'the drop-off wrote a processed_units_daily row it has no business owning',
    ).toBe(0);
  });

  it('PRECEDENCE — a MyMRC-closed processed day does not make the drop-off count twice', async () => {
    // The handoff's Correction 1: `processed_units_daily` has three-to-four
    // writers under a precedence rule, and anything adding to inventory must
    // respect it rather than assume a lock. This flow's answer is that it never
    // writes that table at all — so the assertion is that a day carrying BOTH a
    // drop-off and a closed MyMRC processed row still resolves to exactly one
    // row of each, with the drop-off added once and the processed subtracted
    // once.
    await db.$executeRawUnsafe(`
      INSERT INTO "processed_units_daily"
        ("id","site_id","production_date","stripped_program","stripped_non_program","source","closed_at","updated_at")
      VALUES ('pud-adr0085','${SITE}',DATE '${DAY}',60,5,'mymrc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);

    await db.$transaction((tx: any) =>
      createFloorDropoff({
        tx,
        siteId: SITE,
        dropoffDate: DAY,
        kind: 'floor_public',
        units: 11,
        photo: { storageKey: `dropoffs/${SITE}/c.jpg`, contentType: 'image/jpeg', byteSize: 1 },
        actorUserId: USER,
      }),
    );

    // The closed MyMRC row is untouched and un-duplicated: `(site_id,
    // production_date)` is unique, and this flow added nothing to it.
    const pud = await db.processedUnitsDaily.findMany({ where: { site_id: SITE } });
    expect(pud).toHaveLength(1);
    expect(pud[0].source).toBe('mymrc');
    expect(pud[0].closed_at).not.toBeNull();

    // …and the drop-off leg holds 11 units ONCE.
    const agg = await db.consumerDropoff.aggregate({
      _sum: { units: true },
      where: { site_id: SITE },
    });
    expect(agg._sum.units, 'the drop-off was added to inventory more than once').toBe(11);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Audit
  // ───────────────────────────────────────────────────────────────────────

  it('audits the insert without recording money or a name', async () => {
    await db.$transaction((tx: any) =>
      createFloorDropoff({
        tx,
        siteId: SITE,
        dropoffDate: DAY,
        kind: 'floor_public',
        units: 2,
        photo: { storageKey: `dropoffs/${SITE}/d.jpg`, contentType: 'image/jpeg', byteSize: 1 },
        actorUserId: USER,
      }),
    );
    const rows = await db.auditLog.findMany({ where: { table_name: 'consumer_dropoffs' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(USER);
    const after = JSON.stringify(rows[0].after);
    expect(after).toContain('ipad_dropoff');
    // The audit row is append-only and long-lived; leaking PII or a cents value
    // INTO it would defeat the point of keeping them out of the table.
    expect(after).not.toMatch(/cents|person_name|consumer_name/);
  });
});
