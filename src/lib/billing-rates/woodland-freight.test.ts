// ADR-0040 amendment (§3.5) — transitional Woodland freight resolver. DB-free: drives the
// REAL resolver against the same in-memory fake `FreightResolverDb` the freight-resolver
// tests use. Covers the §3.5 decision tree: Primary (override) → Primary rate; no override
// + mileage → Event Mile tier fallback; no override + no mileage → FreightUnresolvableError;
// unknown source → source_not_found; OR source → WoodlandJurisdictionError.

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveWoodlandFreightCents, WoodlandJurisdictionError } from './woodland-freight';
import { FreightUnresolvableError, type FreightResolverDb } from './freight-resolver';

interface Override {
  id: string;
  source_id: string;
  effective_from: Date;
  effective_to: Date | null;
  rate_cents: number;
}
interface Tier {
  id: string;
  jurisdiction: 'CA' | 'OR';
  min_miles: number;
  max_miles: number;
  rate_cents: number;
  effective_from: Date;
  effective_to: Date | null;
}
interface Src {
  id: string;
  canonical_mileage: number | null;
  jurisdiction: 'california' | 'oregon';
}

const overrides: Override[] = [];
const tiers: Tier[] = [];
const sources: Src[] = [];

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

const db: FreightResolverDb = {
  accountHaulRate: {
    findMany: async ({ where, take }) => {
      const lte = where.effective_from.lte.getTime();
      return overrides
        .filter(
          (o) =>
            o.source_id === where.source_id &&
            o.effective_from.getTime() <= lte &&
            (o.effective_to === null || o.effective_to.getTime() >= lte),
        )
        .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime())
        .slice(0, take);
    },
  },
  source: {
    findUnique: async ({ where }) => {
      const s = sources.find((x) => x.id === where.id);
      return s
        ? { id: s.id, canonical_mileage: s.canonical_mileage, site: { jurisdiction: s.jurisdiction } }
        : null;
    },
  },
  transportRateTier: {
    findMany: async ({ where }) => {
      const lte = where.effective_from.lte.getTime();
      return tiers
        .filter(
          (t) =>
            t.jurisdiction === where.jurisdiction &&
            t.min_miles <= where.min_miles.lte &&
            t.max_miles >= where.max_miles.gte &&
            t.effective_from.getTime() <= lte &&
            (t.effective_to === null || t.effective_to.getTime() >= lte),
        )
        .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime());
    },
  },
};

// The seeded CA Event Mile Rate bands (used as the §3.5 fallback tier).
const CA_TIERS: Omit<Tier, 'jurisdiction' | 'effective_from' | 'effective_to'>[] = [
  { id: 't0', min_miles: 0, max_miles: 25, rate_cents: 42500 },
  { id: 't1', min_miles: 26, max_miles: 50, rate_cents: 60000 },
  { id: 't2', min_miles: 51, max_miles: 100, rate_cents: 92500 },
];

beforeEach(() => {
  overrides.length = 0;
  tiers.length = 0;
  sources.length = 0;
  for (const t of CA_TIERS) {
    tiers.push({ ...t, jurisdiction: 'CA', effective_from: D('2026-01-01'), effective_to: null });
  }
});

describe('resolveWoodlandFreightCents — §3.5 always-Primary', () => {
  it('uses the Primary rate (account override) when one is in force', async () => {
    sources.push({ id: 'gvcc', canonical_mileage: 40, jurisdiction: 'california' });
    overrides.push({
      id: 'ov1',
      source_id: 'gvcc',
      effective_from: D('2026-06-01'),
      effective_to: null,
      rate_cents: 92500,
    });
    const r = await resolveWoodlandFreightCents({ sourceId: 'gvcc', date: D('2026-07-03'), db });
    expect(r).toEqual({ cents: 92500, ref: { kind: 'override', id: 'ov1' } });
  });

  it('falls back to the Event Mile tier by Primary mileage when no override is defined', async () => {
    sources.push({ id: 'src-a', canonical_mileage: 40, jurisdiction: 'california' });
    const r = await resolveWoodlandFreightCents({ sourceId: 'src-a', date: D('2026-07-03'), db });
    expect(r).toEqual({ cents: 60000, ref: { kind: 'tier', id: 't1' } });
  });

  it('throws FreightUnresolvableError (no_mileage) when neither Primary rate nor mileage exists', async () => {
    sources.push({ id: 'unset', canonical_mileage: null, jurisdiction: 'california' });
    await expect(
      resolveWoodlandFreightCents({ sourceId: 'unset', date: D('2026-07-03'), db }),
    ).rejects.toMatchObject({ name: 'FreightUnresolvableError', reason: 'no_mileage' });
  });

  it('throws source_not_found for an unknown source', async () => {
    await expect(
      resolveWoodlandFreightCents({ sourceId: 'ghost', date: D('2026-07-03'), db }),
    ).rejects.toMatchObject({ name: 'FreightUnresolvableError', reason: 'source_not_found' });
  });
});

describe('resolveWoodlandFreightCents — CA-only guard', () => {
  it('throws WoodlandJurisdictionError for an Oregon source (routing bug)', async () => {
    sources.push({ id: 'eugene-src', canonical_mileage: 40, jurisdiction: 'oregon' });
    try {
      await resolveWoodlandFreightCents({ sourceId: 'eugene-src', date: D('2026-07-03'), db });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WoodlandJurisdictionError);
      expect((e as WoodlandJurisdictionError).jurisdiction).toBe('OR');
    }
  });

  it('does not leak an OR source into the tier fallback (never a silent CA price)', async () => {
    sources.push({ id: 'eugene-src', canonical_mileage: 40, jurisdiction: 'oregon' });
    await expect(
      resolveWoodlandFreightCents({ sourceId: 'eugene-src', date: D('2026-07-03'), db }),
    ).rejects.not.toBeInstanceOf(FreightUnresolvableError);
  });
});
