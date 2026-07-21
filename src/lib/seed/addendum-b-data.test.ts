// ADR-0037 amendment (rollup §1/§2/§4) — invariant guards for the Addendum-B seed
// data (11 SVDP internal stores, source aliases, provenance agencies). These
// constants are seeded by prisma/seed.mjs AND mirrored in the 20260730b migration;
// the end-to-end DB seed is validated separately. This pure test protects the data's
// internal consistency so a bad edit fails fast in CI (no DB required).

import { describe, expect, it } from 'vitest';
import {
  SVDP_INTERNAL_STORES,
  CANONICAL_OR_NAMES,
  SOURCE_ALIASES,
  PROVENANCE_AGENCIES,
} from '../../../prisma/seed/addendum-b-data.mjs';

describe('Addendum-B seed data invariants', () => {
  it('lists exactly the 11 SVDP internal stores from rollup §4', () => {
    expect(SVDP_INTERNAL_STORES).toHaveLength(11);
    expect(new Set(SVDP_INTERNAL_STORES).size).toBe(11); // no duplicates
    for (const s of ['Division', 'CARS', 'Cleveland WH', 'Chad Drive']) {
      expect(SVDP_INTERNAL_STORES).toContain(s);
    }
  });

  it('every source alias is globally unique (source_aliases.alias is UNIQUE)', () => {
    const aliases = SOURCE_ALIASES.map(([a]) => a);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('every alias resolves to a known canonical MyMRC source name', () => {
    const canonical = new Set(CANONICAL_OR_NAMES);
    for (const [alias, target] of SOURCE_ALIASES) {
      expect(canonical, `alias "${alias}" → unknown canonical "${target}"`).toContain(target);
    }
  });

  it('preserves the retired verbatim seed names as aliases (id-preserving rename)', () => {
    const aliases = SOURCE_ALIASES.map(([a]) => a);
    for (const oldName of [
      'Salem-Keizer Recycling Center',
      'Albany-Linn County Transfer Station',
      'Cottage Grove Transfer Station',
      'Florence Transfer Station',
      'Glenwood Transfer & Recycling Station',
    ]) {
      expect(aliases, `retired seed name "${oldName}" must remain an alias`).toContain(oldName);
    }
  });

  it('keeps the verbatim MRC "Recieving" typo in the Glenwood canonical name', () => {
    expect(CANONICAL_OR_NAMES).toContain('Glenwood Central Recieving Station');
  });

  it('reclassifies Sponsors as a provenance agency (never a source or drop-off kind)', () => {
    const names = PROVENANCE_AGENCIES.map(([n]) => n);
    expect(names).toEqual(['Sponsors', 'Eugene Mattress Company', 'U-Haul']);
    expect(new Set(names).size).toBe(names.length);
    // No provenance-agency name collides with a source alias (distinct namespaces).
    const aliasSet = new Set(SOURCE_ALIASES.map(([a]) => a));
    for (const n of names) expect(aliasSet.has(n)).toBe(false);
  });
});
