// ADR-0142 — the MRC Monthly Invoice + SVdP internal CSV exports take each Pacific
// site-day from exactly ONE source, against a REAL Postgres.
//
// Both routes filtered on `INVOICE_STATUSES` alone, which includes `submitted`. At
// Woodland that emitted the per-load iPad dock captures (`b2b_haul`, `submitted`) AND
// the MyMRC daily aggregate (`mymrc_haul`, `verified`) for the SAME hauls: September
// 2026 carried 172 dock rows (19,545 units) on top of 25 aggregate rows (21,804). The
// fix applies the inventory's ADR-0060 D5 precedence: a day holding a VERIFIED
// aggregate row is billed from that row only; per-load rows are exported only for days
// with no aggregate.
//
// The real route handlers run here (auth stubbed to a manager of the fixture site) so
// the assertion is on the CSV a manager downloads, not on a helper.
//
// ── FALSIFIED (2026-10-08) ─────────────────────────────────────────────────────
// Against f32a067's routes the September exports emit 7 rows / 740 units instead of
// 5 / 670 (the two dock rows on the Sep 10 aggregate day — including the 19:00 PDT one
// whose UTC date is the next day — ride alongside the aggregate), and the October export
// emits the Sep 30 17:04 PDT dock load whose Pacific day the Sep 30 aggregate owns.
// The other-site aggregate case passes on both (it guards against an over-broad fix).
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { pacificDayISO } from '@/lib/time';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'exports.single-source.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the route reads one database and the fixture is written to another.',
  );
}

const NS = 'adr0142-export';
const SITE = `${NS}-site`;
const SOURCE = `${NS}-source`;
// A second site whose aggregate sits on a day that is dock-only at SITE. It must not
// suppress SITE's dock rows: the aggregate lookup is site-scoped.
const OTHER_SITE = `${NS}-other-site`;

vi.mock('@/lib/auth-helpers', () => ({
  requireManagerForSite: async () => ({
    siteId: 'adr0142-export-site',
    siteCode: 'woodland',
    siteName: 'Export Probe',
    userId: 'adr0142-export-manager',
    role: 'manager',
  }),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const SITE_FIELDS = {
  code: NS,
  name: 'Export Probe',
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

interface Fx {
  id: string;
  type: 'b2b_haul' | 'mymrc_haul';
  status: 'submitted' | 'verified' | 'voided';
  at: string;
  units: number;
  site?: string;
}

// September 2026 is PDT (UTC-7): Pacific midnight = 07:00Z.
const FIXTURE: Fx[] = [
  // Sep 10 — aggregate AND two dock rows for the same hauls → aggregate only.
  {
    id: `${NS}-agg-0910`,
    type: 'mymrc_haul',
    status: 'verified',
    at: '2026-09-10T07:00:00Z',
    units: 500,
  },
  {
    id: `${NS}-dock-0910a`,
    type: 'b2b_haul',
    status: 'submitted',
    at: '2026-09-10T16:00:00Z',
    units: 30,
  },
  // 19:00 PDT on Sep 10 — the UTC date is Sep 11. Must still be matched to Sep 10.
  {
    id: `${NS}-dock-0910b`,
    type: 'b2b_haul',
    status: 'submitted',
    at: '2026-09-11T02:00:00Z',
    units: 40,
  },
  // Sep 11 — dock only → exported.
  {
    id: `${NS}-dock-0911`,
    type: 'b2b_haul',
    status: 'submitted',
    at: '2026-09-11T17:00:00Z',
    units: 25,
  },
  // Another site's aggregate on Sep 11 — must not touch SITE's Sep 11 dock row.
  {
    id: `${NS}-other-agg-0911`,
    type: 'mymrc_haul',
    status: 'verified',
    at: '2026-09-11T07:00:00Z',
    units: 777,
    site: OTHER_SITE,
  },
  // Sep 12 — aggregate only → exported.
  {
    id: `${NS}-agg-0912`,
    type: 'mymrc_haul',
    status: 'verified',
    at: '2026-09-12T07:00:00Z',
    units: 60,
  },
  // Sep 13 — a VOIDED aggregate does not own the day; the dock row is the source.
  {
    id: `${NS}-agg-0913v`,
    type: 'mymrc_haul',
    status: 'voided',
    at: '2026-09-13T07:00:00Z',
    units: 999,
  },
  {
    id: `${NS}-dock-0913`,
    type: 'b2b_haul',
    status: 'submitted',
    at: '2026-09-13T18:00:00Z',
    units: 15,
  },
  // Month edge. Sep 30 aggregate (UTC 2026-09-30T07:00Z → September's file) and a dock
  // load at 17:04 PDT Sep 30, whose UTC instant (2026-10-01T00:04Z) falls in OCTOBER's
  // UTC-month window. Its Pacific day is aggregate-owned, so October drops it.
  {
    id: `${NS}-agg-0930`,
    type: 'mymrc_haul',
    status: 'verified',
    at: '2026-09-30T07:00:00Z',
    units: 70,
  },
  {
    id: `${NS}-dock-0930-edge`,
    type: 'b2b_haul',
    status: 'submitted',
    at: '2026-10-01T00:04:00Z',
    units: 131,
  },
  // Oct 2 — dock only → October keeps it (the control for the edge case).
  {
    id: `${NS}-dock-1002`,
    type: 'b2b_haul',
    status: 'submitted',
    at: '2026-10-02T18:00:00Z',
    units: 12,
  },
];

const EXPECTED_IDS = [
  `${NS}-agg-0910`,
  `${NS}-dock-0911`,
  `${NS}-agg-0912`,
  `${NS}-dock-0913`,
  `${NS}-agg-0930`,
];
const EXPECTED_PER_DAY: Record<string, number> = {
  '2026-09-10': 500,
  '2026-09-11': 25,
  '2026-09-12': 60,
  '2026-09-13': 15,
  '2026-09-30': 70,
};

async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(
    `DELETE FROM "inbound_loads" WHERE "site_id" IN ('${SITE}', '${OTHER_SITE}')`,
  );
}

function parseCsv(csv: string): Array<Record<string, string>> {
  // Fixture values contain no commas or quotes, so a plain split is exact here.
  const [header, ...lines] = csv.trim().split('\r\n');
  const cols = header!.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i]!, v])));
}

const get = async (
  route: { GET: (r: Request) => Promise<Response> },
  path: string,
  month = '2026-09',
) => {
  const res = await route.GET(new Request(`http://test${path}?site=woodland&month=${month}`));
  expect(res.status).toBe(200);
  return parseCsv(await res.text());
};

describe.skipIf(!REAL_DB)('ADR-0142 — invoice exports: one source per Pacific site-day', () => {
  beforeAll(async () => {
    const { PrismaClient: PC } = (await import('@prisma/client')) as {
      PrismaClient: typeof PrismaClient;
    };
    db = new PC({ datasources: { db: { url: REAL_DB! } } });
    await cleanup(db);
    await db.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
    await db.site.upsert({
      where: { id: OTHER_SITE },
      update: {},
      create: { id: OTHER_SITE, ...SITE_FIELDS, code: `${NS}-other`, name: 'Export Probe Other' },
    });
    await db.source.upsert({
      where: { id: SOURCE },
      update: {},
      create: { id: SOURCE, site_id: SITE, name: 'Export Probe Yard' },
    });
    for (const f of FIXTURE) {
      await db.inboundLoad.create({
        data: {
          id: f.id,
          site_id: f.site ?? SITE,
          source_id: f.type === 'b2b_haul' ? SOURCE : null,
          load_source_type: f.type,
          status: f.status,
          arrived_at: new Date(f.at),
          total_units: f.units,
          ...(f.status === 'voided'
            ? { voided_at: new Date(), voided_by_label: 'adr0142-test' }
            : {}),
        },
      });
    }
  });

  afterAll(async () => {
    if (db) {
      await cleanup(db);
      await db.$disconnect();
    }
  });

  it('SVdP export: aggregate day → aggregate row only; dock-only days keep their dock rows', async () => {
    const rows = await get(await import('@/app/api/exports/svdp/route'), '/api/exports/svdp');
    expect(rows.map((r) => r['DR3 Load ID']).sort()).toEqual([...EXPECTED_IDS].sort());

    const perDay: Record<string, number> = {};
    for (const r of rows) {
      const day = pacificDayISO(new Date(r['Arrived At']!));
      perDay[day] = (perDay[day] ?? 0) + Number(r['Unit Count at Unload']);
    }
    expect(perDay).toEqual(EXPECTED_PER_DAY);
  });

  it('MRC export: same single-source rows, total = sum of the per-day sources', async () => {
    const rows = await get(await import('@/app/api/exports/mrc/route'), '/api/exports/mrc');
    expect(rows).toHaveLength(EXPECTED_IDS.length);
    const total = rows.reduce((s, r) => s + Number(r['Unit Count at Unload']), 0);
    expect(total).toBe(670);
  });

  it("another site's aggregate does not suppress this site's dock rows", async () => {
    const rows = await get(await import('@/app/api/exports/svdp/route'), '/api/exports/svdp');
    const ids = rows.map((r) => r['DR3 Load ID']);
    expect(ids).toContain(`${NS}-dock-0911`);
    expect(ids).not.toContain(`${NS}-other-agg-0911`);
  });

  it('month edge: the 17:04 PDT Sep 30 dock load is dropped from OCTOBER (its Pacific day is aggregate-owned)', async () => {
    const rows = await get(
      await import('@/app/api/exports/svdp/route'),
      '/api/exports/svdp',
      '2026-10',
    );
    expect(rows.map((r) => r['DR3 Load ID'])).toEqual([`${NS}-dock-1002`]);
  });
});
