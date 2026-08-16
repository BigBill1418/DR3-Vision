// ADR-0104 §D6/§D10 — the coverage read's arithmetic, pinned so it cannot drift.
//
// The fake below is built to be FALSIFIABLE rather than agreeable, following
// `commodity-ledger.test.ts`. This repo has shipped green-because-the-mock-lied
// twice, so:
//
//   - `where.doc_source_version_id` is honoured ONLY when the caller supplies
//     it, so deleting the version pin from the module returns BOTH revisions and
//     the weighed-load count doubles to a number the assertion names;
//   - `where.status` likewise, so mixing staged into a confirmed total shows up
//     as a different answer rather than as nothing;
//   - `where.site_id` likewise on both tables, so site scoping is measured;
//   - `orderBy.absorbed_at` is READ, not hardcoded, and the two revisions carry
//     DIFFERENT weights, so flipping the module to `asc` picks the older one and
//     the total changes. Byte-identical fixtures would have left the direction
//     unpinned — exactly how the production triple-count got through (ADR-0077).
//
// The figures are the live document's own shape, measured 2026-08-16: the
// workbook supplies 831 loads for Woodland Jan–Jun 2026 against a
// `mymrc_outbound_mirror` holding 4,673 loads back to 2023, all weightless.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';
const V1 = 'ver-older';
const V2 = 'ver-newer';

interface LoadRow {
  site_id: string;
  status: string;
  doc_source_version_id: string;
  absorbed_at: Date;
  external_materials_id: string;
  total_weight_lbs: number | null;
}
interface CommodityRow {
  site_id: string;
  status: string;
  doc_source_version_id: string;
  commodity: string;
  weight_lbs: number | null;
}
interface MirrorRow {
  site_id: string;
  external_materials_id: string | null;
  shipment_date: Date | null;
}

const store = {
  loads: [] as LoadRow[],
  commodities: [] as CommodityRow[],
  mirror: [] as MirrorRow[],
  sites: [] as { id: string; name: string }[],
};

function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const key of ['site_id', 'status', 'doc_source_version_id']) {
    if (where[key] !== undefined && r[key] !== where[key]) return false;
  }
  return true;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    docOutboundLoadRow: {
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: Record<string, unknown>;
          orderBy?: { absorbed_at?: 'asc' | 'desc' };
        }) => {
          // Reads the direction the CALLER asked for.
          const dir = orderBy?.absorbed_at ?? 'asc';
          return (
            store.loads
              .filter((r) => matches(r as unknown as Record<string, unknown>, where))
              .sort((a, b) =>
                dir === 'desc'
                  ? b.absorbed_at.getTime() - a.absorbed_at.getTime()
                  : a.absorbed_at.getTime() - b.absorbed_at.getTime(),
              )[0] ?? null
          );
        },
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.loads.filter((r) => matches(r as unknown as Record<string, unknown>, where)),
      ),
    },
    docOutboundCommodityRow: {
      groupBy: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rows = store.commodities.filter((r) =>
          matches(r as unknown as Record<string, unknown>, where),
        );
        const by = new Map<string, { n: number; w: number }>();
        for (const r of rows) {
          const cur = by.get(r.commodity) ?? { n: 0, w: 0 };
          by.set(r.commodity, { n: cur.n + 1, w: cur.w + (r.weight_lbs ?? 0) });
        }
        return [...by.entries()].map(([commodity, v]) => ({
          commodity,
          _count: { _all: v.n },
          _sum: { weight_lbs: v.w },
        }));
      }),
    },
    mymrcOutboundMirror: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.mirror.filter((r) => {
          if (where['site_id'] !== undefined && r.site_id !== where['site_id']) return false;
          // `external_materials_id: { not: null }` — honoured, so a mirror row
          // with no id cannot silently become a denominator.
          if (where['external_materials_id'] !== undefined && r.external_materials_id === null) {
            return false;
          }
          return true;
        }),
      ),
    },
    site: { findMany: vi.fn(async () => store.sites) },
  },
}));

import { computeOutboundCoverage, monthKey, UNDATED_BUCKET } from '../outbound-reconcile';

function mirrorLoad(id: string, iso: string | null, site = WOODLAND): MirrorRow {
  return {
    site_id: site,
    external_materials_id: id,
    // The live mirror stores shipment dates at 12:00 UTC, not midnight.
    shipment_date: iso === null ? null : new Date(`${iso}T12:00:00.000Z`),
  };
}

function absorbed(
  id: string,
  weight: number | null,
  over: Partial<LoadRow> = {},
): LoadRow {
  return {
    site_id: WOODLAND,
    status: 'confirmed',
    doc_source_version_id: V2,
    absorbed_at: new Date('2026-08-16T00:00:00.000Z'),
    external_materials_id: id,
    total_weight_lbs: weight,
    ...over,
  };
}

beforeEach(() => {
  store.loads = [];
  store.commodities = [];
  store.mirror = [];
  store.sites = [
    { id: WOODLAND, name: 'DR3 Woodland' },
    { id: EUGENE, name: 'DR3 Eugene' },
  ];
});

describe('computeOutboundCoverage — the version pin (ADR-0077)', () => {
  /**
   * Two CONFIRMED revisions of one workbook, deliberately left confirmed. A
   * total that is only correct when somebody remembered to discard the older
   * batch is not a guarantee.
   */
  function twoRevisions(): void {
    store.mirror = [mirrorLoad('M-1', '2026-02-02'), mirrorLoad('M-2', '2026-02-03')];
    // The OLDER revision carries different weights, so picking the wrong one is
    // a different ANSWER rather than an identical-looking pass.
    // The NEWER revision is listed FIRST on purpose. The read builds a Map keyed
    // on the Materials ID, and a map collapses a duplicate silently — so with
    // the older rows last, dropping the version clause changes the WEIGHT
    // (last write wins) as well as tripping `revisionBleedIds`. With the older
    // rows first it would not, and the mutation would survive. It did: this
    // fixture order was wrong on the first attempt and the whole file stayed
    // green with the pin deleted.
    store.loads = [
      absorbed('M-1', 8100),
      absorbed('M-2', 7420),
      absorbed('M-1', 1000, { doc_source_version_id: V1, absorbed_at: new Date('2026-08-01T00:00:00.000Z') }),
      absorbed('M-2', 2000, { doc_source_version_id: V1, absorbed_at: new Date('2026-08-01T00:00:00.000Z') }),
    ];
  }

  it('pins ONE revision and never sums across them', async () => {
    twoRevisions();
    const c = await computeOutboundCoverage(WOODLAND);

    expect(c.versionId).toBe(V2);
    // 2 mirror loads, 2 weighed. NOT 4 — which is what an unpinned read would
    // report, against a denominator of 2, i.e. 200% coverage.
    expect(c.totals.mirrorLoads).toBe(2);
    expect(c.totals.loadsWithWeight).toBe(2);
    expect(c.totals.weightLbs).toBe(15520);
    // The pin's own alarm. `(version, materials id)` is UNIQUE, so a repeat can
    // only mean a second revision is in scope. Deleting the version clause from
    // the query makes this list non-empty AND drops the weight to 3,000.
    expect(c.revisionBleedIds).toEqual([]);
  });

  it('takes the NEWEST revision, not the first one it finds', async () => {
    twoRevisions();
    const c = await computeOutboundCoverage(WOODLAND);
    // The older revision's weights are 3,000 lb. If the module ordered `asc`
    // this would be 3000 and the version id would be V1.
    expect(c.totals.weightLbs).not.toBe(3000);
    expect(c.absorbedAtISO).toBe('2026-08-16T00:00:00.000Z');
  });

  it('never mixes staged into a confirmed total', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02')];
    store.loads = [
      absorbed('M-1', 8100),
      absorbed('M-1', 9999, {
        status: 'staged',
        doc_source_version_id: 'ver-staged',
        absorbed_at: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ];

    const confirmed = await computeOutboundCoverage(WOODLAND, { scope: 'confirmed' });
    expect(confirmed.totals.weightLbs).toBe(8100);
    expect(confirmed.totals.loadsWithWeight).toBe(1);

    // The staged view is a separate, complete answer — never added to the other.
    const staged = await computeOutboundCoverage(WOODLAND, { scope: 'staged' });
    expect(staged.totals.weightLbs).toBe(9999);
    expect(staged.versionId).toBe('ver-staged');
  });

  it('scopes to the site on BOTH sides of the join', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02'), mirrorLoad('M-9', '2026-02-02', EUGENE)];
    store.loads = [absorbed('M-1', 8100), absorbed('M-9', 500, { site_id: EUGENE })];

    const c = await computeOutboundCoverage(WOODLAND);
    // Eugene's load is neither a denominator nor a numerator here.
    expect(c.totals.mirrorLoads).toBe(1);
    expect(c.totals.weightLbs).toBe(8100);
  });
});

describe('computeOutboundCoverage — what it reports', () => {
  it('states the uncovered loads plainly, and they are the majority', async () => {
    // The real proportion: the workbook covers Jan–Jun 2026 only, against a
    // mirror going back to 2023.
    store.mirror = [
      mirrorLoad('M-old-1', '2023-01-02'),
      mirrorLoad('M-old-2', '2025-11-14'),
      mirrorLoad('M-1', '2026-02-02'),
      mirrorLoad('M-2', '2026-02-03'),
      mirrorLoad('M-late', '2026-07-11'),
    ];
    store.loads = [absorbed('M-1', 8100), absorbed('M-2', 7420)];

    const c = await computeOutboundCoverage(WOODLAND);
    expect(c.totals.mirrorLoads).toBe(5);
    expect(c.totals.loadsWithWeight).toBe(2);
    // The bad headline, stated rather than hidden (P-47).
    expect(c.totals.loadsWithoutWeight).toBe(3);

    // Months are newest-first and every month the MIRROR knows about appears,
    // including the ones the workbook cannot cover.
    expect(c.months.map((m) => [m.month, m.mirrorLoads, m.loadsWithWeight])).toEqual([
      ['2026-07', 1, 0],
      ['2026-02', 2, 2],
      ['2025-11', 1, 0],
      ['2023-01', 1, 0],
    ]);
  });

  it('counts an absorbed load whose own weight cell was BLANK as uncovered', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02')];
    store.loads = [absorbed('M-1', null)];

    const c = await computeOutboundCoverage(WOODLAND);
    // The row exists, so the load MATCHED — but the workbook supplies no figure
    // for it, and calling that "covered" would report a weight nobody wrote.
    expect(c.totals.loadsWithWeight).toBe(0);
    expect(c.totals.loadsWithoutWeight).toBe(1);
    expect(c.unmatchedAbsorbedLoads).toEqual([]);
  });

  it('reports an absorbed load the mirror has never heard of', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02')];
    store.loads = [absorbed('M-1', 8100), absorbed('M-ghost', 4000)];

    const c = await computeOutboundCoverage(WOODLAND);
    // Invisible in any coverage percentage, which only counts the mirror's side.
    // A weight for a shipment with no other trace is a finding.
    expect(c.unmatchedAbsorbedLoads).toEqual(['M-ghost']);
    expect(c.totals.mirrorLoads).toBe(1);
  });

  it('buckets a mirror load with no shipment date separately, never into a month', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02'), mirrorLoad('M-nodate', null)];
    store.loads = [absorbed('M-1', 8100)];

    const c = await computeOutboundCoverage(WOODLAND);
    const undated = c.months.find((m) => m.month === UNDATED_BUCKET);
    expect(undated?.mirrorLoads).toBe(1);
    // Sorted last, so it never reads as the newest month.
    expect(c.months.at(-1)?.month).toBe(UNDATED_BUCKET);
  });

  it('sums the commodity split inside the pinned revision only', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02')];
    store.loads = [absorbed('M-1', 8100)];
    store.commodities = [
      { site_id: WOODLAND, status: 'confirmed', doc_source_version_id: V2, commodity: 'Steel', weight_lbs: 6561 },
      { site_id: WOODLAND, status: 'confirmed', doc_source_version_id: V2, commodity: 'Waste', weight_lbs: 1539 },
      // The superseded revision's copy. Included, it would double Steel.
      { site_id: WOODLAND, status: 'confirmed', doc_source_version_id: V1, commodity: 'Steel', weight_lbs: 6561 },
    ];

    const c = await computeOutboundCoverage(WOODLAND);
    expect(c.commodities).toEqual([
      { commodity: 'Steel', rows: 1, weightLbs: 6561 },
      { commodity: 'Waste', rows: 1, weightLbs: 1539 },
    ]);
  });

  it('returns an awaiting shape rather than a clean grid of zeroes', async () => {
    const c = await computeOutboundCoverage(WOODLAND);
    expect(c.awaiting).toBe(true);
    expect(c.versionId).toBeNull();
    expect(c.months).toEqual([]);
  });

  it('reports nothing bleeding between revisions on a healthy read', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02')];
    store.loads = [absorbed('M-1', 8100)];
    expect((await computeOutboundCoverage(WOODLAND)).revisionBleedIds).toEqual([]);
  });

  it('GRADES NOTHING — no verdict field exists to be read', async () => {
    store.mirror = [mirrorLoad('M-1', '2026-02-02')];
    store.loads = [absorbed('M-1', 8100)];
    const c = await computeOutboundCoverage(WOODLAND);

    // AK-4c is Bill's decision with Rick and Janette (P-48). A threshold added
    // here would become the default by being first, so its ABSENCE is asserted:
    // if somebody adds one, this test names what they have to also change.
    const keys = Object.keys(c);
    for (const forbidden of ['ok', 'verdict', 'status', 'mismatch', 'tolerance', 'threshold']) {
      expect(keys, `coverage must not grade the join (${forbidden})`).not.toContain(forbidden);
    }
    expect(JSON.stringify(c)).not.toMatch(/tolerance|threshold|mismatch/i);
  });
});

describe('monthKey', () => {
  it('reads the calendar month in UTC on both sides of the join', () => {
    // The mirror stores 12:00 UTC and the absorbed rows store 00:00 UTC. A
    // session-zone cast would move a load shipped on the 1st into the previous
    // month on one side only, and a month whose numerator and denominator
    // disagree about which loads it holds is worse than no month at all.
    expect(monthKey(new Date('2026-02-01T12:00:00.000Z'))).toBe('2026-02');
    expect(monthKey(new Date('2026-02-01T00:00:00.000Z'))).toBe('2026-02');
    expect(monthKey(null)).toBe(UNDATED_BUCKET);
  });
});
