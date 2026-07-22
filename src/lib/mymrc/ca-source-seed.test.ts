// ADR-0057 Addendum A (§A.1 / §A.8.2) — invariants for the CA source disambiguation
// suggestion source + its office aliases. Pure (no DB): guards the data's internal
// consistency + the D4 lock-step between the typed constant (the classifier reads) and
// the seed alias pairs (seed.mjs writes) so a bad edit fails fast in CI.

import { describe, expect, it } from 'vitest';
import {
  CA_SOURCE_DISAMBIGUATION,
  CA_SOURCE_DISAMBIGUATION_PENDING,
  type CaCandidateSiteType,
} from './ca-source-seed';
import {
  CA_OFFICE_SOURCE_ALIASES,
  SOURCE_ALIASES,
  WOODLAND_SOURCE_ALIASES,
} from '../../../prisma/seed/addendum-b-data.mjs';

const byType = (t: CaCandidateSiteType) => CA_SOURCE_DISAMBIGUATION.filter((r) => r.siteType === t);
const names = new Set(CA_SOURCE_DISAMBIGUATION.map((r) => r.mymrcName));

describe('CA_SOURCE_DISAMBIGUATION — confirmed §A.1 rows', () => {
  it('carries the 7 confirmed rows (2 mrc_inbound + 1 cvp_retailer + 4 non_mrc_dropoff)', () => {
    expect(CA_SOURCE_DISAMBIGUATION).toHaveLength(7);
    expect(byType('mrc_inbound')).toHaveLength(2);
    expect(byType('cvp_retailer')).toHaveLength(1);
    expect(byType('non_mrc_dropoff')).toHaveLength(4);
  });

  it('has a unique canonical name per row (the reconciliation match key)', () => {
    expect(names.size).toBe(CA_SOURCE_DISAMBIGUATION.length);
  });

  it('is entirely California', () => {
    for (const r of CA_SOURCE_DISAMBIGUATION) expect(r.state).toBe('CA');
  });

  it('carries Rick’s explicit per-office is_program flags (Go Getter is the sole program office)', () => {
    const office = Object.fromEntries(byType('non_mrc_dropoff').map((r) => [r.mymrcName, r.isProgram]));
    expect(office).toEqual({
      'Golden Bear': false,
      'Recology Healdsburg': false,
      'Go Getter Company': true,
      'Recology Sonoma': false,
    });
  });

  it('routes mrc_inbound to the program pool and cvp_retailer out of it', () => {
    for (const r of byType('mrc_inbound')) expect(r.isProgram).toBe(true);
    for (const r of byType('cvp_retailer')) expect(r.isProgram).toBe(false);
  });

  it('resolves Humboldt Moving to the EXISTING Crescent City yard (in-catalog alias, with address)', () => {
    const h = CA_SOURCE_DISAMBIGUATION.find((r) => r.mymrcName.startsWith('Humboldt Moving'));
    expect(h).toBeDefined();
    expect(h!.inCatalog).toBe(true);
    expect(h!.city).toBe('Crescent City');
    expect(h!.zip).toBe('95531');
    expect(h!.siteType).toBe('mrc_inbound');
  });

  it('marks not-yet-catalogued sources as new_record candidates with no fabricated address', () => {
    for (const r of CA_SOURCE_DISAMBIGUATION.filter((x) => !x.inCatalog)) {
      // Never invented: a new source carries no address until the queue approves it.
      expect(r.street, `${r.mymrcName} must not carry a fabricated street`).toBeNull();
      expect(r.city).toBeNull();
      expect(r.zip).toBeNull();
    }
  });

  it('holds exactly one in-catalog row (only Humboldt pre-exists)', () => {
    expect(CA_SOURCE_DISAMBIGUATION.filter((r) => r.inCatalog)).toHaveLength(1);
  });
});

describe('CA_SOURCE_DISAMBIGUATION_PENDING — unresolved hints (never suggestions)', () => {
  it('holds the 5 surviving workbook-nickname hints (2 mrc_inbound + 3 cvp_retailer)', () => {
    expect(CA_SOURCE_DISAMBIGUATION_PENDING).toHaveLength(5);
    expect(CA_SOURCE_DISAMBIGUATION_PENDING.filter((p) => p.siteType === 'mrc_inbound')).toHaveLength(2);
    expect(CA_SOURCE_DISAMBIGUATION_PENDING.filter((p) => p.siteType === 'cvp_retailer')).toHaveLength(3);
  });

  it('never overlaps a confirmed canonical name (a hint must not masquerade as resolved)', () => {
    for (const p of CA_SOURCE_DISAMBIGUATION_PENDING) {
      expect(names.has(p.hint), `pending hint "${p.hint}" collides with a confirmed name`).toBe(false);
    }
  });
});

describe('CA_OFFICE_SOURCE_ALIASES — §A.8.2 office short forms', () => {
  it('carries the 4 office aliases, globally unique', () => {
    expect(CA_OFFICE_SOURCE_ALIASES).toHaveLength(4);
    const aliases = CA_OFFICE_SOURCE_ALIASES.map(([a]) => a);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('resolves every alias to a canonical name in CA_SOURCE_DISAMBIGUATION (D4 lock-step)', () => {
    for (const [alias, canonical] of CA_OFFICE_SOURCE_ALIASES) {
      expect(names, `alias "${alias}" → unknown canonical "${canonical}"`).toContain(canonical);
      // and that canonical is an office row (non_mrc_dropoff)
      const row = CA_SOURCE_DISAMBIGUATION.find((r) => r.mymrcName === canonical);
      expect(row!.siteType).toBe('non_mrc_dropoff');
    }
  });

  it('never collides with an OR or Woodland alias (source_aliases.alias is globally UNIQUE)', () => {
    const others = new Set([
      ...SOURCE_ALIASES.map(([a]) => a),
      ...WOODLAND_SOURCE_ALIASES.map(([a]) => a),
    ]);
    for (const [alias] of CA_OFFICE_SOURCE_ALIASES) {
      expect(others.has(alias), `CA office alias "${alias}" collides with an existing alias`).toBe(false);
    }
  });
});
