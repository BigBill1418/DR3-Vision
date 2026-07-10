// ADR-0040 D2 — freight resolver matrix. DB-free: drives the REAL resolver against
// an in-memory fake `db` (mirrors the ADR signature `resolveFreightCents({sourceId,
// date, db})`). Covers: override beats tier; tier boundary miles 25/26; missing
// mileage → typed error; OR (unseeded) → typed error; source-not-found.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveFreightCents,
  FreightUnresolvableError,
  type FreightResolverDb,
} from './freight-resolver';

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

// Fake Prisma delegate surface — replicates the `where` filters the resolver sends.
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
        ? {
            id: s.id,
            canonical_mileage: s.canonical_mileage,
            site: { jurisdiction: s.jurisdiction },
          }
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

describe('resolveFreightCents — tier path', () => {
  it('prices a CA source by its canonical mileage band', async () => {
    sources.push({ id: 'src-woodland-a', canonical_mileage: 40, jurisdiction: 'california' });
    const r = await resolveFreightCents({ sourceId: 'src-woodland-a', date: D('2026-07-03'), db });
    expect(r).toEqual({ cents: 60000, ref: { kind: 'tier', id: 't1' } });
  });

  it('resolves boundary miles 25 and 26 to adjacent bands', async () => {
    sources.push(
      { id: 's25', canonical_mileage: 25, jurisdiction: 'california' },
      { id: 's26', canonical_mileage: 26, jurisdiction: 'california' },
    );
    expect((await resolveFreightCents({ sourceId: 's25', date: D('2026-07-03'), db })).cents).toBe(
      42500,
    );
    expect((await resolveFreightCents({ sourceId: 's26', date: D('2026-07-03'), db })).cents).toBe(
      60000,
    );
  });
});

describe('resolveFreightCents — override path', () => {
  it('an in-force account override beats the tier band', async () => {
    sources.push({ id: 'gvcc', canonical_mileage: 40, jurisdiction: 'california' });
    overrides.push({
      id: 'ov1',
      source_id: 'gvcc',
      effective_from: D('2026-06-01'),
      effective_to: null,
      rate_cents: 92500,
    });
    const r = await resolveFreightCents({ sourceId: 'gvcc', date: D('2026-07-03'), db });
    expect(r).toEqual({ cents: 92500, ref: { kind: 'override', id: 'ov1' } });
  });

  it('an EXPIRED override falls through to the tier band', async () => {
    sources.push({ id: 'gvcc', canonical_mileage: 40, jurisdiction: 'california' });
    overrides.push({
      id: 'old',
      source_id: 'gvcc',
      effective_from: D('2025-01-01'),
      effective_to: D('2025-12-31'),
      rate_cents: 10000,
    });
    const r = await resolveFreightCents({ sourceId: 'gvcc', date: D('2026-07-03'), db });
    expect(r.ref).toEqual({ kind: 'tier', id: 't1' });
  });
});

describe('resolveFreightCents — typed failures (never a silent $0)', () => {
  it('throws no_mileage when the source has no canonical mileage and no override', async () => {
    sources.push({ id: 'nomiles', canonical_mileage: null, jurisdiction: 'california' });
    await expect(
      resolveFreightCents({ sourceId: 'nomiles', date: D('2026-07-03'), db }),
    ).rejects.toMatchObject({ name: 'FreightUnresolvableError', reason: 'no_mileage' });
  });

  it('throws no_tier_for_mileage for an OR source (OR tiers unseeded)', async () => {
    sources.push({ id: 'eugene-src', canonical_mileage: 40, jurisdiction: 'oregon' });
    try {
      await resolveFreightCents({ sourceId: 'eugene-src', date: D('2026-07-03'), db });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FreightUnresolvableError);
      expect((e as FreightUnresolvableError).reason).toBe('no_tier_for_mileage');
      expect((e as FreightUnresolvableError).context.jurisdiction).toBe('OR');
      expect((e as FreightUnresolvableError).context.mileage).toBe(40);
    }
  });

  it('throws no_tier_for_mileage when CA mileage exceeds the top band', async () => {
    sources.push({ id: 'faraway', canonical_mileage: 999, jurisdiction: 'california' });
    await expect(
      resolveFreightCents({ sourceId: 'faraway', date: D('2026-07-03'), db }),
    ).rejects.toMatchObject({ reason: 'no_tier_for_mileage' });
  });

  it('throws source_not_found for an unknown source', async () => {
    await expect(
      resolveFreightCents({ sourceId: 'ghost', date: D('2026-07-03'), db }),
    ).rejects.toMatchObject({ reason: 'source_not_found' });
  });
});
