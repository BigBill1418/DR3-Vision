// ADR-0040 D6 — variance report tests. DB-free (injected `db` + `provider`). Covers:
// the honest empty state (provider unavailable → tier-now only, zero leakage) and the
// leakage math on a fixture (the GVCC $425→$925/haul example from the ADR).

import { describe, it, expect } from 'vitest';
import {
  buildVarianceReport,
  varianceToCsv,
  UNAVAILABLE_PROVIDER,
  type VarianceDb,
  type VarianceProvider,
} from './variance';

interface Src {
  id: string;
  name: string;
  canonical_mileage: number | null;
  jurisdiction: 'california' | 'oregon';
}
interface Tier {
  min_miles: number;
  max_miles: number;
  rate_cents: number;
}

function makeDb(sources: Src[], tiers: Tier[]): VarianceDb {
  return {
    source: {
      findMany: async () =>
        sources.map((s) => ({
          id: s.id,
          name: s.name,
          canonical_mileage: s.canonical_mileage,
          site: { jurisdiction: s.jurisdiction },
        })),
    },
    transportRateTier: {
      // CA_TIERS are CA-only, matching the seed (no OR tiers exist).
      findMany: async ({ where }) =>
        where.jurisdiction !== 'CA'
          ? []
          : tiers
              .filter((t) => t.min_miles <= where.min_miles.lte && t.max_miles >= where.max_miles.gte)
              .map((t) => ({ ...t, effective_from: new Date('2026-01-01'), effective_to: null })),
    },
  };
}

const CA_TIERS: Tier[] = [
  { min_miles: 0, max_miles: 25, rate_cents: 42500 }, // $425
  { min_miles: 26, max_miles: 50, rate_cents: 60000 },
  { min_miles: 51, max_miles: 100, rate_cents: 92500 }, // $925
];

const DATE = new Date('2026-07-03T00:00:00Z');

describe('buildVarianceReport — honest empty state (no workbook history on main)', () => {
  it('populates tier-now but leaves last-billed/leakage null when provider unavailable', async () => {
    const db = makeDb([{ id: 'gvcc', name: 'GVCC', canonical_mileage: 80, jurisdiction: 'california' }], CA_TIERS);
    const report = await buildVarianceReport({ date: DATE, db, provider: UNAVAILABLE_PROVIDER });
    expect(report.provider_available).toBe(false);
    expect(report.total_monthly_leakage_cents).toBe(0);
    expect(report.rows[0]).toMatchObject({
      source_name: 'GVCC',
      tier_now_cents: 92500,
      last_billed_mileage: null,
      per_haul_delta_cents: null,
      monthly_leakage_cents: null,
    });
  });

  it('notes an unresolvable OR source (no OR tiers seeded)', async () => {
    const db = makeDb([{ id: 'eug', name: 'Eugene Src', canonical_mileage: 40, jurisdiction: 'oregon' }], CA_TIERS);
    const report = await buildVarianceReport({ date: DATE, db });
    expect(report.rows[0]!.tier_now_cents).toBeNull();
    expect(report.rows[0]!.note).toContain('OR');
  });
});

describe('buildVarianceReport — leakage math (GVCC $425→$925/haul)', () => {
  const provider: VarianceProvider = {
    available: true,
    // GVCC was last billed on Stockton-era 20 miles ($425 tier); its real mileage is 80
    // ($925 tier). 12 hauls/month.
    historyFor: () => ({ lastBilledMileage: 20, haulsPerMonth: 12 }),
  };

  it('computes per-haul delta and monthly leakage', async () => {
    const db = makeDb([{ id: 'gvcc', name: 'GVCC', canonical_mileage: 80, jurisdiction: 'california' }], CA_TIERS);
    const report = await buildVarianceReport({ date: DATE, db, provider });
    const row = report.rows[0]!;
    expect(row.tier_last_cents).toBe(42500); // $425
    expect(row.tier_now_cents).toBe(92500); // $925
    expect(row.per_haul_delta_cents).toBe(50000); // $500/haul
    expect(row.monthly_leakage_cents).toBe(600000); // $500 × 12 = $6,000/mo
    expect(report.total_monthly_leakage_cents).toBe(600000);
  });

  it('renders CSV with a TOTAL row in dollars', async () => {
    const db = makeDb([{ id: 'gvcc', name: 'GVCC', canonical_mileage: 80, jurisdiction: 'california' }], CA_TIERS);
    const report = await buildVarianceReport({ date: DATE, db, provider });
    const csv = varianceToCsv(report);
    expect(csv).toContain('GVCC,CA,80,925.00,20,425.00,500.00,12,6000.00,');
    expect(csv).toContain('TOTAL,,,,,,,,6000.00,');
  });
});
