// ADR-0125 — the EOD inbound gap-fill line, against a REAL Postgres.
//
// Two claims a mock cannot carry:
//
//   1. THE FREIGHT CHECKBOX ROUND-TRIPS TO THE ROW. `transport_charged` had NO
//      writer and read `false` on all 743 production rows, which is why the CA
//      freight leg selected an empty set in silence. "The checkbox works" is a
//      claim about a column, so it is asserted by reading the column back.
//   2. THE DOUBLE-COUNT GUARD REFUSES. `onHand` counts both per-load rows and
//      the one-per-day aggregate rows, so a per-load line on a day an aggregate
//      already covers would count those units twice — in the floor and in the
//      billing basis.
//
// ── FALSIFIED BY HAND (2026-08-24) ─────────────────────────────────────────
//
// Disabling the aggregate refusal in `addEodInboundLine` takes
// "REFUSES a per-load line on a day an aggregate already covers" red with
//   AssertionError: expected { …(11) } to be an instance of EodInboundConflictError
// — i.e. the line LANDS, and 25 aggregate units plus 7 per-load units then both
// stand for one Pacific day, which `onHand` sums as 32.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dayKeyUTCFromISO, pacificMidnightInstantOfDayISO } from '@/lib/time';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'inbound-line.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let addEodInboundLine: typeof import('./inbound-line').addEodInboundLine;
let setInboundTransportCharged: typeof import('./inbound-line').setInboundTransportCharged;
let EodInboundConflictError: typeof import('./inbound-line').EodInboundConflictError;

const NS = 'adr0125-inbound';
const SITE = `${NS}-site`;
const ACTOR = `${NS}-actor`;
const SRC_FREIGHT = `${NS}-src-freight`;
const SRC_PLAIN = `${NS}-src-plain`;
const DAY = dayKeyUTCFromISO('2026-08-20');
const DAY_INSTANT = pacificMidnightInstantOfDayISO('2026-08-20');

const siteFields = {
  code: `${NS}-code`,
  name: 'EOD Inbound Probe',
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

async function seed(): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
  await db.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...siteFields } });
  await db.user.upsert({
    where: { id: ACTOR },
    update: {},
    create: { id: ACTOR, name: 'EOD Inbound Probe', role: 'manager', primary_site_id: SITE },
  });
  await db.source.upsert({
    where: { id: SRC_FREIGHT },
    update: { is_trans_charge: true },
    create: {
      id: SRC_FREIGHT,
      site_id: SITE,
      name: `${NS} Freight Source`,
      is_trans_charge: true,
    },
  });
  await db.source.upsert({
    where: { id: SRC_PLAIN },
    update: { is_trans_charge: false },
    create: { id: SRC_PLAIN, site_id: SITE, name: `${NS} Plain Source`, is_trans_charge: false },
  });
}

const line = (over: Record<string, unknown> = {}) => ({
  siteId: SITE,
  dayKey: DAY,
  totalUnits: 7,
  programUnits: 7,
  nonProgramUnits: 0,
  actorUserId: ACTOR,
  ...over,
});

describe.skipIf(!REAL_DB)('ADR-0125 — the EOD inbound line against a real database', () => {
  beforeEach(async () => {
    if (!db) {
      const { PrismaClient } = await import('@prisma/client');
      db = new PrismaClient({ datasources: { db: { url: REAL_DB as string } } });
      const mod = await import('./inbound-line');
      addEodInboundLine = mod.addEodInboundLine;
      setInboundTransportCharged = mod.setInboundTransportCharged;
      EodInboundConflictError = mod.EodInboundConflictError;
    }
    await seed();
  });

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
      await db.$disconnect();
    }
  });

  it('THE FREIGHT CHECKBOX ROUND-TRIPS — ticked on the add-line, true on the row', async () => {
    const view = await addEodInboundLine(line({ transportCharged: true }));
    expect(view.transportCharged).toBe(true);

    const row = await db.inboundLoad.findUnique({ where: { id: view.id } });
    expect(row.transport_charged).toBe(true);
    // The unticked case is the control: without it, a column hardcoded `true`
    // would satisfy the assertion above.
    const off = await addEodInboundLine(
      line({ transportCharged: false, totalUnits: 3, programUnits: 3 }),
    );
    const offRow = await db.inboundLoad.findUnique({ where: { id: off.id } });
    expect(offRow.transport_charged).toBe(false);
  });

  it('defaults the freight flag from the SOURCE classifier when the caller does not say', async () => {
    const fromFreightSource = await addEodInboundLine(line({ sourceId: SRC_FREIGHT }));
    expect(fromFreightSource.transportCharged).toBe(true);

    const fromPlainSource = await addEodInboundLine(
      line({ sourceId: SRC_PLAIN, totalUnits: 4, programUnits: 4 }),
    );
    expect(fromPlainSource.transportCharged).toBe(false);
  });

  it('an EXPLICIT checkbox overrides the source classifier', async () => {
    // A freight source with the box deliberately cleared. The classifier
    // proposes; the person with the paperwork disposes.
    const view = await addEodInboundLine(line({ sourceId: SRC_FREIGHT, transportCharged: false }));
    const row = await db.inboundLoad.findUnique({ where: { id: view.id } });
    expect(row.transport_charged).toBe(false);
  });

  it('captures the workbook identifiers that had a home and no writer', async () => {
    const view = await addEodInboundLine(
      line({
        bolNumber: 'BOL-991',
        dr3Number: '4761',
        haulNumber: `${NS}-H-1`,
        slipNumber: 'S-12',
        weightLbs: 385,
      }),
    );
    const row = await db.inboundLoad.findUnique({ where: { id: view.id } });
    expect(row.bol_number).toBe('BOL-991');
    expect(row.dr3_number).toBe('4761');
    expect(row.external_mymrc_haul_id).toBe(`${NS}-H-1`);
    expect(row.slip_number).toBe('S-12');
    expect(row.weight_lbs).toBe(385);
    // Admissible to `onHand` on the same terms as any other inbound: verified,
    // and its split sums.
    expect(row.status).toBe('verified');
    expect(row.program_unit_count + row.non_program_unit_count).toBe(row.total_units);
    // ADR-0125 D10 — the DR3 number was TYPED. Nothing consumed a sequence.
    const seq = await db.documentSequence.findFirst({
      where: { site_id: SITE, sequence_code: 'dr3_number' },
    });
    expect(seq).toBeNull();
  });

  it('audits the gap-fill, naming it as one', async () => {
    const view = await addEodInboundLine(line({ bolNumber: 'BOL-1' }));
    const audit = await db.auditLog.findMany({
      where: { table_name: 'inbound_loads', row_id: view.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('insert');
    expect(audit[0].actor_user_id).toBe(ACTOR);
    expect(audit[0].after).toMatchObject({ eod_gap_fill: true, arrived_at: '2026-08-20' });
  });

  it('REFUSES a per-load line on a day an aggregate already covers (the double-count guard)', async () => {
    // A manager paper-bulk whole-day total for the same Pacific day.
    await db.inboundLoad.create({
      data: {
        site_id: SITE,
        load_source_type: 'paper_bulk',
        count_mode: 'total',
        status: 'verified',
        arrived_at: DAY_INSTANT,
        total_units: 25,
        program_unit_count: 25,
        non_program_unit_count: 0,
      },
    });

    const err = await addEodInboundLine(line()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EodInboundConflictError);
    expect((err as InstanceType<typeof EodInboundConflictError>).reason).toBe(
      'aggregate_covers_day',
    );
    expect((err as InstanceType<typeof EodInboundConflictError>).status).toBe(409);

    // Nothing landed — the refusal is not a warning.
    const perLoad = await db.inboundLoad.count({
      where: { site_id: SITE, load_source_type: 'b2b_haul' },
    });
    expect(perLoad).toBe(0);
  });

  it('ALLOWS the same line on a day with no aggregate (the positive control)', async () => {
    // Without this, an `addEodInboundLine` that refused everything would satisfy
    // the case above and the guard would be untested.
    const view = await addEodInboundLine(line({ dayKey: dayKeyUTCFromISO('2026-08-19') }));
    expect(view.dayKey).toBe('2026-08-19');
  });

  it('refuses a haul number another load already owns', async () => {
    await addEodInboundLine(line({ haulNumber: `${NS}-H-DUP` }));
    const err = await addEodInboundLine(
      line({ haulNumber: `${NS}-H-DUP`, totalUnits: 2, programUnits: 2 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EodInboundConflictError);
    expect((err as InstanceType<typeof EodInboundConflictError>).reason).toBe('haul_number_taken');
  });

  it('refuses a split that does not sum — MRC is billed on the program pool', async () => {
    await expect(
      addEodInboundLine(line({ totalUnits: 10, programUnits: 6, nonProgramUnits: 3 })),
    ).rejects.toThrow(/must equal total_units/);
  });

  it('CORRECTS the freight flag on a row written before the column had a writer', async () => {
    const view = await addEodInboundLine(line({ transportCharged: false }));
    await setInboundTransportCharged({
      siteId: SITE,
      loadId: view.id,
      transportCharged: true,
      actorUserId: ACTOR,
    });
    const row = await db.inboundLoad.findUnique({ where: { id: view.id } });
    expect(row.transport_charged).toBe(true);

    const audit = await db.auditLog.findMany({
      where: { table_name: 'inbound_loads', row_id: view.id },
      orderBy: { created_at: 'asc' },
    });
    expect(audit).toHaveLength(2);
    expect(audit[1].after).toMatchObject({ transport_charged: true });
  });

  it('refuses a cross-site correction — the site rides in the WHERE, not in a read above it', async () => {
    const view = await addEodInboundLine(line());
    await expect(
      setInboundTransportCharged({
        siteId: 'some-other-site',
        loadId: view.id,
        transportCharged: true,
        actorUserId: ACTOR,
      }),
    ).rejects.toThrow(/not found at this site/);
    const row = await db.inboundLoad.findUnique({ where: { id: view.id } });
    expect(row.transport_charged).toBe(false);
  });
});
