// ADR-0115 (F-4) — the transportation leg must SAY when it resolves nothing.
//
// `resolveTransportationInputs` selects `where transport_charged = true`.
// Nothing in the codebase writes that column — it is DDL-default `false`, read
// at `generation-inputs.ts:272` and `leg-fetchers.ts:105`, written nowhere — so
// the select has always returned zero rows. Every per-load failure below the
// select throws loudly, but a zero-row select just skips the loop: no freight
// legs, no fuel legs, no error, and a CA transportation invoice that is
// structurally empty with nothing anywhere saying so.
//
// This suite pins the DISCRIMINATION, which is the whole point of the warning:
// "zero transport-charged loads" means two completely different things and a
// warning that fires on both is noise that will be tuned out.
//
//   quiet window      — no billing-ready inbound at all  → info, no warn
//   silent under-bill — inbound exists, none flagged      → warn
//
// A single-branch test would pass on a `log.warn` that fires unconditionally,
// so both branches are asserted against the same fixture and the same code path.
//
// Real database, not a fake: the sibling suite
// `generation-inputs.status-filter.db.test.ts` is named `.db.test.ts` but
// injects a hand-rolled predicate emulator, so it is asserting its own fixture's
// idea of the `where` clause rather than Postgres's. The count query added for
// this discrimination has to be measured against a real planner or the test
// restates the mock.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { log } from '@/lib/observability/logger';
import { resolveTransportationInputs } from './generation-inputs';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// `resolveTransportationInputs` writes and reads through the `@/lib/prisma`
// singleton (DATABASE_URL) while the fixture below is seeded through this
// suite's own client (DR3_TEST_DATABASE_URL). If those named different
// databases the suite would seed one and query the other, and "zero
// transport-charged loads" would be true for the boring reason.
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'transportation-zero-row.db.test.ts: set DATABASE_URL to the same value as ' +
      'DR3_TEST_DATABASE_URL — otherwise the fixture and the code under test ' +
      'address different databases.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'f4-zero-row';
const SITE = `${NS}-site`;
const SOURCE = `${NS}-source`;

// A Pacific-August window; the load below arrives inside it.
const WINDOW_START = '2026-08-01';
const WINDOW_END = '2026-08-31';
const ARRIVED = new Date('2026-08-10T18:00:00.000Z'); // 11:00 PDT, unambiguously inside

async function clearLoads(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
}

describe.skipIf(!REAL_DB)('resolveTransportationInputs — zero-row reporting (F-4)', () => {
  beforeAll(async () => {
    const { PrismaClient: PC } = (await import('@prisma/client')) as {
      PrismaClient: typeof PrismaClient;
    };
    db = new PC({ datasources: { db: { url: REAL_DB! } } });
    await clearLoads(db);
    await db.site.upsert({
      where: { id: SITE },
      update: {},
      create: {
        id: SITE,
        code: NS,
        name: 'F4 Zero Row Site',
        jurisdiction: 'california',
        mrc_program_code: 'MRC-CA-TEST',
        customer_service_open: '08:00',
        customer_service_close: '16:00',
        recycling_rate_target_pct: 70,
        records_retention_years: 5,
        inbound_processing_deadline_days: 60,
        mymrc_inbound_submission_business_days: 3,
        mymrc_processed_submission_business_days: 1,
        dock_sla_minutes: 60,
        reconciliation_target_pct: 97,
        billing_cadence: 'mid_month_and_end',
      },
    });
    await db.source.upsert({
      where: { id: SOURCE },
      update: {},
      create: { id: SOURCE, site_id: SITE, name: 'F4 Zero Row Yard', canonical_mileage: 100 },
    });
  });

  afterAll(async () => {
    if (db) {
      await clearLoads(db);
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    await clearLoads(db);
    vi.restoreAllMocks();
  });

  async function run(): Promise<{ warns: string[]; infos: string[] }> {
    const warns: string[] = [];
    const infos: string[] = [];
    vi.spyOn(log, 'warn').mockImplementation(((_o: unknown, m?: string) => {
      warns.push(typeof _o === 'string' ? _o : (m ?? ''));
    }) as never);
    vi.spyOn(log, 'info').mockImplementation(((_o: unknown, m?: string) => {
      infos.push(typeof _o === 'string' ? _o : (m ?? ''));
    }) as never);
    const out = await resolveTransportationInputs({
      siteId: SITE,
      kind: 'ca_transportation_eom',
      billingMonthISO: WINDOW_START,
      windowStartISO: WINDOW_START,
      windowEndISO: WINDOW_END,
    });
    expect(out.freightLoads).toHaveLength(0);
    expect(out.fuelLoads).toHaveLength(0);
    return { warns, infos };
  }

  it('WARNS when billing-ready inbound exists in the window but none is transport-charged', async () => {
    // The exact live shape: a real, billable load whose `transport_charged` is
    // the DDL default. Before this change the leg returned empty in silence.
    await db.inboundLoad.create({
      data: {
        site_id: SITE,
        source_id: SOURCE,
        status: 'submitted',
        arrived_at: ARRIVED,
        total_units: 30,
        // transport_charged deliberately left at its `false` default.
      },
    });

    const { warns } = await run();
    expect(warns.join('\n')).toMatch(/ZERO transport-charged loads/);
    expect(warns.join('\n')).toMatch(/UNDER-BILLED/);
  });

  it('does NOT warn on a genuinely quiet window — no billing-ready inbound at all', async () => {
    const { warns, infos } = await run();
    expect(warns).toEqual([]);
    expect(infos.join('\n')).toMatch(/no billing-ready inbound in the window/);
  });

  it('does NOT warn when the only inbound in the window is not billing-ready', async () => {
    // `expected` is outside INVOICE_STATUSES, so it is not an under-bill — the
    // leg is correctly empty and must stay quiet. This is the case a count that
    // forgot the status filter would get wrong.
    await db.inboundLoad.create({
      data: {
        site_id: SITE,
        source_id: SOURCE,
        status: 'expected',
        arrived_at: ARRIVED,
        total_units: 30,
      },
    });

    const { warns } = await run();
    expect(warns).toEqual([]);
  });
});
