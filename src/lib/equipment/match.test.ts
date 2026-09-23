// ADR-0135 B — the matcher, pinned against the REAL production cases from the
// 2026-09-22 registry sweep (ADR-0135 §1/§5/§6). Every name below is a row that
// exists (or existed) in production.

import { describe, expect, it } from 'vitest';
import {
  generateDisplayName,
  identifyingUnits,
  matchEquipment,
  nameKey,
  pickerMatches,
  probableDuplicates,
  unitKey,
  unitPrefix,
  unitTokens,
  type MatchableEquipment,
} from './match';

const EUG = 'site-eugene';
const WDL = 'site-woodland';

function row(
  id: string,
  displayName: string,
  over: Partial<MatchableEquipment> = {},
): MatchableEquipment {
  return {
    id,
    displayName,
    category: 'vehicle',
    siteId: EUG,
    isActive: true,
    mergedIntoId: null,
    ...over,
  };
}

const REGISTRY: MatchableEquipment[] = [
  row('fl161053', '161053 — Freightliner Semi Truck (Day Cab S/A)', { siteId: WDL }),
  row('t3248', '32-48 — Trailer 48 Ft Swing Door Trailer'),
  row('t3200', '3248 — Great Dane Trailer'),
  row('terex', 'Terex', { siteId: WDL, category: 'terex' }),
  row('t19', 'Trailer #19'),
  row('t4868', '4868 — Fruehauf 28 Ft Roll Up Door Trailer'),
  row('f9', 'F9 — Hyster Forklift', { category: 'forklift' }),
  row('eq24', 'EQ24 — Shear Machine', { siteId: WDL, category: 'terex' }),
  row('eq23', 'EQ23 — Horizontal Baler', { siteId: WDL, category: 'baler' }),
  row('t281577', '281577 — Great Dane', { siteId: WDL }),
  row('truck19', '19 — Ford Truck'),
  // A merged loser keeps its old spelling and points at its survivor.
  row('old161053', '161053.', { siteId: WDL, isActive: false, mergedIntoId: 'fl161053' }),
];

describe('unitTokens / unitKey — the unit number is the identity', () => {
  it.each([
    ['161053.', ['161053']],
    ['161053 — Freightliner Semi Truck (Day Cab S/A)', ['161053']],
    ['trailer 32-48', ['32-48']],
    ['Trailer # 19', ['19']],
    ['Trailer #19', ['19']],
    ['Trailer Number #7677', ['7677']],
    ['EQ24 Terex Shredder', ['EQ24']],
    ['F9', ['F9']],
    ['48-68 trailer', ['48-68']],
    ['terex', []],
  ])('%s → %j', (input, expected) => {
    expect(unitTokens(input)).toEqual(expected);
  });

  it('keeps the dash: 48-68 and 4868 are different keys', () => {
    expect(unitKey('48-68')).toBe('48-68');
    expect(unitKey('4868')).toBe('4868');
    expect(unitKey('48-68')).not.toBe(unitKey('4868'));
    expect(unitKey('32-48')).not.toBe(unitKey('3248'));
  });

  it("a length is not an identity (`28 Ft`, `53'`)", () => {
    expect(unitTokens('4868 — Fruehauf 28 Ft Roll Up Door Trailer')).toEqual(['4868']);
    expect(unitTokens("53' dry van 5312")).toEqual(['5312']);
  });

  it('fixes O/I look-alikes only inside an otherwise-numeric token', () => {
    expect(unitKey('16IO53')).toBe('161053');
    expect(unitKey('EQ10')).toBe('EQ10');
  });

  it('a seed-format name is identified by the part before the spaced dash', () => {
    expect(identifyingUnits('32-48 — Trailer 48 Ft Swing Door Trailer')).toEqual(['32-48']);
    expect(identifyingUnits('Trailer 540010')).toEqual(['540010']);
    expect(identifyingUnits('Green baler', '7')).toEqual(['7']);
  });
});

describe('probableDuplicates — what the server gate refuses on', () => {
  const ids = (q: Parameters<typeof probableDuplicates>[0]) =>
    probableDuplicates(q, REGISTRY).map((m) => m.row.id);

  it('`161053.` hits `161053 — Freightliner …` (the whole-name compare missed it)', () => {
    expect(ids({ text: '161053.' })).toEqual(['fl161053']);
  });

  it('`trailer 32-48` hits `32-48 — Trailer …` and NOT `3248 — Great Dane Trailer`', () => {
    expect(ids({ text: 'trailer 32-48' })).toEqual(['t3248']);
  });

  it('`terex` hits `Terex` (case only)', () => {
    expect(ids({ text: 'terex' })).toEqual(['terex']);
  });

  it('`Trailer # 19` hits `Trailer #19` but not the Ford TRUCK 19', () => {
    expect(ids({ text: 'Trailer # 19' })).toEqual(['t19']);
  });

  it('`48-68 trailer` does NOT match `4868 — Fruehauf …` — the dash is a different trailer', () => {
    expect(ids({ text: '48-68 trailer' })).toEqual([]);
    expect(
      matchEquipment({ text: '48-68 trailer' }, REGISTRY, { includeWordMatches: false }),
    ).toEqual([]);
  });

  it('`F9` hits `F9 — Hyster Forklift`', () => {
    expect(ids({ text: 'F9' })).toEqual(['f9']);
  });

  it('structured unit number joins the text (`Great Dane Trailer`, unit 281577)', () => {
    expect(ids({ text: 'Great Dane Trailer', unitNumber: '281577' })).toEqual(['t281577']);
  });

  it('matches ACROSS sites — the Eugene row is found from a Woodland query', () => {
    expect(ids({ text: 'Trailer 281577' })).toEqual(['t281577']);
  });

  it('a merged loser resolves to its survivor, never to itself', () => {
    const m = matchEquipment({ text: '161053.' }, REGISTRY);
    expect(m.map((x) => x.row.id)).toEqual(['fl161053']);
  });

  it('a short unit on a different KIND of asset is shown but not a probable duplicate', () => {
    const m = matchEquipment({ text: 'Trailer 19' }, REGISTRY, { includeWordMatches: false });
    const truck = m.find((x) => x.row.id === 'truck19');
    expect(truck?.reason).toBe('same_unit');
    expect(truck?.probableDuplicate).toBe(false);
  });

  it('a VIN hit is the strongest', () => {
    const rows = [row('vin', '1DW1A5321PS807745')];
    expect(
      probableDuplicates({ text: 'Dump truck', vinSerial: '1dw1a5321ps807745' }, rows),
    ).toHaveLength(1);
  });

  it('a genuinely new asset matches nothing (`Trailer # 5327`)', () => {
    expect(ids({ text: 'Trailer # 5327' })).toEqual([]);
  });
});

describe('matchEquipment — search ranking', () => {
  it('word search finds the baler family', () => {
    const m = matchEquipment({ text: 'green horizontal baler' }, REGISTRY);
    expect(m[0]?.row.id).toBe('eq23');
    expect(m[0]?.reason).toBe('words');
    expect(m[0]?.probableDuplicate).toBe(false);
  });

  it('`EQ24 Terex Shredder` ranks `EQ24 — Shear Machine` first (unit beats words)', () => {
    const m = matchEquipment({ text: 'EQ24 Terex Shredder' }, REGISTRY);
    expect(m[0]?.row.id).toBe('eq24');
    expect(m.map((x) => x.row.id)).toContain('terex');
  });

  it('empty or punctuation-only query returns nothing, not the whole registry', () => {
    expect(matchEquipment({ text: '' }, REGISTRY)).toEqual([]);
    expect(matchEquipment({ text: ' . ' }, REGISTRY)).toEqual([]);
  });
});

describe('pickerMatches — the approver picker filter', () => {
  it.each([
    ['Trailer # 19', 'Trailer #19', true],
    ['trailer 19', 'Trailer #19', true],
    ['161053', '161053 — Freightliner Semi Truck (Day Cab S/A)', true],
    ['161053.', '161053 — Freightliner Semi Truck (Day Cab S/A)', true],
    ['fruehauf', '4868 — Fruehauf 28 Ft Roll Up Door Trailer', true],
    ['48-68', '4868 — Fruehauf 28 Ft Roll Up Door Trailer', false],
    ['terex', 'Terex', true],
    ['', 'anything', true],
  ])('%j finds %j → %s', (q, name, expected) => {
    expect(pickerMatches(q, name)).toBe(expected);
  });
});

describe('generateDisplayName — the seed convention, generated', () => {
  it('builds `<unit> — <make> <type>`', () => {
    expect(
      generateDisplayName({ unitNumber: '161053', make: 'Freightliner', assetType: 'Semi Truck' }),
    ).toBe('161053 — Freightliner Semi Truck');
    expect(generateDisplayName({ unitNumber: ' 5327 ', assetType: 'Trailer' })).toBe(
      '5327 — Trailer',
    );
    expect(generateDisplayName({ make: 'Harmony', assetType: 'Baler' })).toBe('Harmony Baler');
  });

  it('nameKey folds case, spacing and punctuation', () => {
    expect(nameKey('Terex  Machine')).toBe(nameKey('terex machine'));
  });
});

describe('the fleet-class word is part of the identity (prod queue, 2026-09-23)', () => {
  const FLEET: MatchableEquipment[] = [
    row('t12', 'Truck 12 — Isuzu Box Truck'),
    row('v12', 'Van 12 — Chevrolet Passenger Van'),
    row('b12', 'Bus 12 — Ford Passenger Van'),
    row('lift1', 'LIFT 1 — Ford'),
    row('c1', '1 — Comet', { siteId: WDL }),
    row('t908', 'Truck 908 — Volvo Semi Truck (Day Cab)'),
    row('t19', 'Trailer #19'),
    row('tr19', '19 — Fruehauf 28 Ft Roll Up Door Trailer'),
  ];
  const dupIds = (text: string) =>
    probableDuplicates({ text }, FLEET)
      .map((m) => m.row.id)
      .sort();

  it('Truck 12 / Van 12 / Bus 12 are three vehicles', () => {
    expect(dupIds('Truck 12')).toEqual(['t12']);
    expect(dupIds('Van 12')).toEqual(['v12']);
  });

  it('`LIFT 1` is not trailer `1`', () => {
    const others = FLEET.filter((r) => r.id !== 'c1');
    expect(probableDuplicates({ text: '1 — Comet' }, others)).toEqual([]);
  });

  it('a bare LONG number still meets its prefixed twin (`908` / `Truck 908`)', () => {
    expect(dupIds('908')).toEqual(['t908']);
  });

  it('`Trailer # 19` meets both trailer 19s, not a truck', () => {
    expect(dupIds('Trailer # 19')).toEqual(['t19', 'tr19']);
  });

  it('unitPrefix reads the class word, skipping filler', () => {
    expect(unitPrefix('Trailer Number #7677', '7677')).toBe('TRAILER');
    expect(unitPrefix('Trucks 9 — GMC', '9')).toBe('TRUCK');
    expect(unitPrefix('161053 — Freightliner', '161053')).toBeNull();
  });
});
