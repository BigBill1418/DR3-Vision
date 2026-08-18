// ADR-0108 — the look-at-this band, pinned so it cannot drift.
//
// Every test below is written to FAIL against the naive implementation of the
// thing it guards, and the failure output is quoted in the ADR. A guard that has
// never been observed failing proves nothing — this repo has shipped
// green-because-the-mock-lied more than once, so the fake honours:
//
//   - `where.doc_source_version_id` ONLY when the caller supplies it, so
//     deleting the version pin puts a superseded revision's rows in scope and a
//     named assertion changes;
//   - `where.status`, so a staged row cannot leak into a confirmed reading;
//   - `where.site_id` on both tables.
//
// The figures are the live document's own shape, measured against prod
// 2026-08-18 from revision 7829de7b: Wood median 3,170 lb with a 1.3026 spread
// step over 220 loads, and a real 40 lb Wood row that a linear ±k×MAD bound
// could never have flagged.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';
const V_OLD = 'ver-superseded';
const V_NEW = 'ver-winning';

interface CommodityRow {
  site_id: string;
  status: string;
  doc_source_version_id: string;
  external_materials_id: string;
  commodity: string;
  weight_lbs: number | null;
}
interface ConfigRow {
  id: string;
  site_id: string;
  commodity: string;
  enabled: boolean;
  median_lbs: number;
  spread_ratio: number;
  k: number;
  min_sample_n: number;
  sample_n: number;
  seed_measured_on: Date | null;
}

const store = { commodities: [] as CommodityRow[], configs: [] as ConfigRow[] };

function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const key of ['site_id', 'status', 'doc_source_version_id']) {
    if (where[key] !== undefined && r[key] !== where[key]) return false;
  }
  return true;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    docOutboundCommodityRow: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.commodities.filter((r) => matches(r as unknown as Record<string, unknown>, where)),
      ),
    },
    outboundVarianceConfig: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.configs.filter((r) => matches(r as unknown as Record<string, unknown>, where)),
      ),
    },
  },
}));

import { computeOutboundVariance, resolveBound } from '../outbound-variance';

/** The measured Wood band: median 3,170 lb, one step = ×1.3026, 220 loads. */
function woodConfig(over: Partial<ConfigRow> = {}): ConfigRow {
  return {
    id: 'cfg-wood',
    site_id: WOODLAND,
    commodity: 'Wood',
    enabled: true,
    median_lbs: 3169.98,
    spread_ratio: 1.3026,
    k: 6,
    min_sample_n: 20,
    sample_n: 220,
    seed_measured_on: new Date('2026-08-18T00:00:00.000Z'),
    ...over,
  };
}

function row(over: Partial<CommodityRow> = {}): CommodityRow {
  return {
    site_id: WOODLAND,
    status: 'staged',
    doc_source_version_id: V_NEW,
    external_materials_id: 'M-1',
    commodity: 'Wood',
    weight_lbs: 3200,
    ...over,
  };
}

const read = (scope: 'confirmed' | 'staged' = 'staged', versionId = V_NEW) =>
  computeOutboundVariance(WOODLAND, { versionId, scope });

beforeEach(() => {
  store.commodities = [];
  store.configs = [];
});

// ── 1. The version pin ───────────────────────────────────────────────────────

describe('the version pin (ADR-0077) excludes a superseded revision', () => {
  /**
   * A revision that was CORRECTED. The old copy of M-9 says 40 lb — the real
   * keying-error shape — and the winning revision says 3,300 lb, which is
   * ordinary. Both are left `staged`, deliberately: a flag list that is only
   * right when somebody remembered to discard the old batch is not a guarantee.
   *
   * Un-pinned code reads both and flags a number nobody is using any more.
   */
  function correctedRevision(): void {
    store.configs = [woodConfig()];
    store.commodities = [
      row({ external_materials_id: 'M-9', weight_lbs: 3300, doc_source_version_id: V_NEW }),
      row({ external_materials_id: 'M-9', weight_lbs: 40, doc_source_version_id: V_OLD }),
    ];
  }

  it('does not flag a load the winning revision already corrected', async () => {
    correctedRevision();
    const v = await read();

    // Drop `doc_source_version_id` from the module's `where` and this becomes
    // ['M-9'] — a flag raised against a superseded figure, presented as live.
    expect(v.flags).toEqual([]);
    expect(v.flaggedLoadIds).toEqual([]);
    expect(v.versionId).toBe(V_NEW);
  });

  it('flags that same row when the superseded revision IS the one asked for', async () => {
    correctedRevision();
    // Proves the fixture is not simply inert: the 40 lb row is flaggable, and
    // the ONLY thing keeping it off the live list is the pin.
    const v = await read('staged', V_OLD);
    expect(v.flaggedLoadIds).toEqual(['M-9']);
    expect(v.flags[0]?.weightLbs).toBe(40);
  });

  it('never mixes a staged row into a confirmed reading', async () => {
    store.configs = [woodConfig()];
    store.commodities = [
      row({ external_materials_id: 'M-7', weight_lbs: 40, status: 'staged' }),
      row({ external_materials_id: 'M-8', weight_lbs: 3300, status: 'confirmed' }),
    ];
    expect((await read('confirmed')).flaggedLoadIds).toEqual([]);
    expect((await read('staged')).flaggedLoadIds).toEqual(['M-7']);
  });

  it('scopes to the site', async () => {
    store.configs = [woodConfig()];
    store.commodities = [row({ external_materials_id: 'M-E', weight_lbs: 40, site_id: EUGENE })];
    expect((await read()).flags).toEqual([]);
  });
});

// ── 2. An uncovered load is never flagged ────────────────────────────────────

describe('an uncovered load is NOT COVERED, never "0 variance"', () => {
  it('raises no flag for a load with no absorbed commodity row at all', async () => {
    store.configs = [woodConfig()];
    // The mirror holds 3,839 Woodland loads the workbook never covered. None of
    // them has a row here, so there is nothing to be unusual — and the absence
    // must not be read as agreement.
    store.commodities = [];

    const v = await read();
    expect(v.flags).toEqual([]);
    expect(v.flaggedLoadIds).toEqual([]);
    // The distinction the screen depends on: no flags because there is nothing
    // to measure, NOT because everything measured was fine.
    expect(v.nothingIsBounded).toBe(false);
  });

  it('raises no flag for an absorbed load whose weight cell was BLANK', async () => {
    store.configs = [woodConfig()];
    store.commodities = [row({ external_materials_id: 'M-blank', weight_lbs: null })];

    // A blank cell is "not recorded". Treating null as 0 would make it 4.0
    // steps below the median and flag a load the workbook says nothing about.
    expect((await read()).flags).toEqual([]);
  });

  it('raises no flag for a RECORDED ZERO', async () => {
    store.configs = [woodConfig()];
    store.commodities = [row({ external_materials_id: 'M-zero', weight_lbs: 0 })];

    // A recorded 0 is the workbook stating "this load carried no Wood" — a
    // fact, not a light load. Flagging it would flag 830 rows of the 1,699.
    expect((await read()).flags).toEqual([]);
  });
});

// ── 3. The line comes from CONFIG, not from a constant ───────────────────────

describe('the flag line is read from config, not compiled in', () => {
  it('moves when the config row moves — no code change', async () => {
    store.commodities = [row({ external_materials_id: 'M-mid', weight_lbs: 1200 })];

    // 1,200 lb against median 3,170 and step 1.3026 is 3.66 steps out.
    store.configs = [woodConfig({ k: 6 })];
    expect((await read()).flags, 'k=6 must leave 1,200 lb alone').toEqual([]);

    // Same row, same code, narrower line.
    store.configs = [woodConfig({ k: 3 })];
    const tightened = await read();
    expect(tightened.flags).toHaveLength(1);
    expect(tightened.flags[0]?.direction).toBe('below');

    // And the band the screen quotes moves with it.
    const wide = resolveBound({ ...woodConfig({ k: 6 }) });
    const tight = resolveBound({ ...woodConfig({ k: 3 }) });
    expect(Math.round(wide.lowLbs ?? 0)).toBe(649);
    expect(Math.round(tight.lowLbs ?? 0)).toBe(1434);
  });

  it('honours `enabled = false` as a full stop for that commodity', async () => {
    store.commodities = [row({ external_materials_id: 'M-40', weight_lbs: 40 })];
    store.configs = [woodConfig({ enabled: false })];

    const v = await read();
    expect(v.flags).toEqual([]);
    expect(v.bounds[0]?.inactiveReason).toBe('turned_off');
    expect(v.nothingIsBounded).toBe(true);
  });

  it('does not treat a commodity with NO config row as being within bounds', async () => {
    store.configs = [woodConfig()];
    store.commodities = [row({ external_materials_id: 'M-s', commodity: 'Steel', weight_lbs: 1 })];

    const v = await read();
    expect(v.flags).toEqual([]);
    // Said out loud rather than silently passing. An absent rule is not a
    // passing grade, and the screen prints this list.
    expect(v.commoditiesWithoutABound).toEqual(['Steel']);
  });
});

// ── 4. The minimum-n floor ───────────────────────────────────────────────────

describe('a commodity with too few observations never flags', () => {
  it('leaves Cotton alone: 3 loads cannot say what normal is', async () => {
    // The live shape. Cotton's three rows are 55, 126 and 23,820 lb — a spread
    // step of ×2.29, which is not a distribution, it is three numbers.
    store.configs = [
      woodConfig({
        id: 'cfg-cotton',
        commodity: 'Cotton',
        median_lbs: 126,
        spread_ratio: 2.2909,
        sample_n: 3,
        min_sample_n: 20,
      }),
    ];
    store.commodities = [
      row({ external_materials_id: 'M-c1', commodity: 'Cotton', weight_lbs: 55 }),
      row({ external_materials_id: 'M-c2', commodity: 'Cotton', weight_lbs: 23820 }),
    ];

    const v = await read();
    // 23,820 against a median of 126 is 6.4 steps out and WOULD flag without
    // the floor. It must not: the band it would be judged against was invented
    // from three rows.
    expect(v.flags).toEqual([]);
    expect(v.bounds[0]?.inactiveReason).toBe('too_few_observations');
    expect(v.bounds[0]?.lowLbs).toBeNull();
  });

  it('flags the same row once the floor is lowered — the floor is what silences it', async () => {
    store.configs = [
      woodConfig({
        id: 'cfg-cotton',
        commodity: 'Cotton',
        median_lbs: 126,
        spread_ratio: 2.2909,
        sample_n: 3,
        min_sample_n: 2,
      }),
    ];
    store.commodities = [
      row({ external_materials_id: 'M-c2', commodity: 'Cotton', weight_lbs: 23820 }),
    ];
    expect((await read()).flaggedLoadIds).toEqual(['M-c2']);
  });

  it('refuses a zero-width spread instead of flagging every row', async () => {
    // The three singleton commodities all seed at ratio 1.0000. A naive band
    // would be [median, median] and flag every load that is not EXACTLY it.
    store.configs = [
      woodConfig({
        id: 'cfg-plastics',
        commodity: 'Plastics',
        median_lbs: 4426,
        spread_ratio: 1,
        sample_n: 1,
        min_sample_n: 1,
      }),
    ];
    store.commodities = [
      row({ external_materials_id: 'M-p', commodity: 'Plastics', weight_lbs: 4427 }),
    ];

    const v = await read();
    expect(v.flags).toEqual([]);
    expect(v.bounds[0]?.inactiveReason).toBe('no_spread');
  });
});

// ── 5. The shape the log-space bound exists for ──────────────────────────────

describe('the low side is reachable at all — which a linear band is not', () => {
  it('flags the measured Wood 40 lb row that a ±k×MAD band could never reach', async () => {
    store.configs = [woodConfig()];
    store.commodities = [row({ external_materials_id: 'M-177843', weight_lbs: 40 })];

    const v = await read();
    expect(v.flaggedLoadIds).toEqual(['M-177843']);
    expect(v.flags[0]?.direction).toBe('below');
    // 16.5 steps out in log space. In LINEAR MAD units it is 3.96 — and Wood's
    // low side caps at median/MAD = 4.01, so no linear k at or above ~4 could
    // ever have reached it, however light the load.
    expect(v.flags[0]?.stepsOut).toBeGreaterThan(16);
    expect(v.flags[0]?.stepsOut).toBeLessThan(17);
  });

  it('flags high and low alike and says which, without ranking them', async () => {
    store.configs = [woodConfig()];
    store.commodities = [
      row({ external_materials_id: 'M-hi', weight_lbs: 40000 }),
      row({ external_materials_id: 'M-lo', weight_lbs: 40 }),
      row({ external_materials_id: 'M-ok', weight_lbs: 3200 }),
    ];

    const v = await read();
    expect(v.flaggedLoadIds).toEqual(['M-hi', 'M-lo']);
    expect(v.flags.map((f) => f.direction).sort()).toEqual(['above', 'below']);
  });
});

// ── 6. It grades nothing ─────────────────────────────────────────────────────

describe('the review object carries no verdict', () => {
  it('exposes no field a caller could render as a judgement', async () => {
    store.configs = [woodConfig()];
    store.commodities = [row({ external_materials_id: 'M-40', weight_lbs: 40 })];
    const v = await read();

    for (const forbidden of ['ok', 'verdict', 'mismatch', 'tolerance', 'error', 'dispute']) {
      expect(Object.keys(v), `the review must not grade (${forbidden})`).not.toContain(forbidden);
    }
    // A flag names a weight, a band and a distance. Nothing else.
    expect(Object.keys(v.flags[0] ?? {}).sort()).toEqual([
      'commodity',
      'direction',
      'externalMaterialsId',
      'highLbs',
      'lowLbs',
      'stepsOut',
      'weightLbs',
    ]);
  });
});
