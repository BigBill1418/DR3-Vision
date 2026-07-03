// ADR-0040 D4 — fuel-surcharge tests. DB-free: mocks `@/lib/prisma` (in-memory
// sites + state_program_rules + fuel_prices), drives the REAL computeFuelSurchargeCents
// (which reuses the REAL resolveProgramRule). Covers: Monday-of-week normalization,
// the $5.05-exact trigger edge, the above-trigger formula, missing-week typed error,
// and the OR structural guard (RuleStructurallyDisallowedError).

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MockSite {
  id: string;
  jurisdiction: 'oregon' | 'california';
}
interface MockRule {
  id: string;
  site_id: string;
  rule_kind: string;
  effective_from: Date;
  effective_to: Date | null;
  rate_cents: number | null;
  params: Record<string, unknown> | null;
}
interface MockFuel {
  week_of: Date;
  usd_per_gal: number;
  source: 'eia_api' | 'manual';
}

const sites: MockSite[] = [];
const rules: MockRule[] = [];
const fuel: MockFuel[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        sites.find((s) => s.id === where.id) ?? null,
    },
    stateProgramRule: {
      findFirst: async ({
        where,
      }: {
        where: {
          site_id: string;
          rule_kind: string;
          effective_from: { lte: Date };
          OR: Array<{ effective_to: null } | { effective_to: { gte: Date } }>;
        };
      }) => {
        const lte = where.effective_from.lte.getTime();
        return (
          rules
            .filter(
              (r) =>
                r.site_id === where.site_id &&
                r.rule_kind === where.rule_kind &&
                r.effective_from.getTime() <= lte &&
                (r.effective_to === null || r.effective_to.getTime() >= lte),
            )
            .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime())[0] ?? null
        );
      },
      // The hardening pass (PR #52) switched the resolver to findMany so it can
      // detect ambiguous effective sets — the mock mirrors the same filter and
      // returns ALL covering rows, newest first.
      findMany: async ({
        where,
      }: {
        where: {
          site_id: string;
          rule_kind: string;
          effective_from: { lte: Date };
          OR: Array<{ effective_to: null } | { effective_to: { gte: Date } }>;
        };
      }) => {
        const lte = where.effective_from.lte.getTime();
        return rules
          .filter(
            (r) =>
              r.site_id === where.site_id &&
              r.rule_kind === where.rule_kind &&
              r.effective_from.getTime() <= lte &&
              (r.effective_to === null || r.effective_to.getTime() >= lte),
          )
          .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime());
      },
    },
    fuelPrice: {
      findUnique: async ({ where }: { where: { week_of: Date } }) =>
        fuel.find((f) => f.week_of.getTime() === where.week_of.getTime()) ?? null,
    },
  },
}));

import {
  computeFuelSurchargeCents,
  resolveFuelPrice,
  mondayOfWeekUTC,
  fuelSurchargeApplies,
  MissingFuelPriceError,
} from './fuel';
import { RuleStructurallyDisallowedError } from '@/lib/program-rules/resolver';

const CA = 'site-woodland';
const OR = 'site-eugene';
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(() => {
  sites.length = 0;
  rules.length = 0;
  fuel.length = 0;
  sites.push({ id: CA, jurisdiction: 'california' }, { id: OR, jurisdiction: 'oregon' });
  rules.push({
    id: 'ca-fuel',
    site_id: CA,
    rule_kind: 'fuel_surcharge',
    effective_from: D('2026-01-01'),
    effective_to: null,
    rate_cents: null,
    params: { formula: '(eia_rate_usd_per_gal / mpg) * miles_driven', mpg: 6.5, trigger_usd_per_gal: 5.05 },
  });
});

describe('mondayOfWeekUTC', () => {
  it('maps any weekday to that week’s Monday (UTC)', () => {
    // 2026-07-03 is a Friday; its ISO week Monday is 2026-06-29.
    expect(mondayOfWeekUTC(D('2026-07-03')).toISOString().slice(0, 10)).toBe('2026-06-29');
    // A Monday maps to itself.
    expect(mondayOfWeekUTC(D('2026-06-29')).toISOString().slice(0, 10)).toBe('2026-06-29');
    // A Sunday maps back to the prior Monday.
    expect(mondayOfWeekUTC(D('2026-07-05')).toISOString().slice(0, 10)).toBe('2026-06-29');
  });
});

describe('fuelSurchargeApplies — trigger edge', () => {
  it('$5.05 exactly does NOT apply; above does', () => {
    expect(fuelSurchargeApplies(5.05, 5.05)).toBe(false);
    expect(fuelSurchargeApplies(5.051, 5.05)).toBe(true);
    expect(fuelSurchargeApplies(4.99, 5.05)).toBe(false);
  });
});

describe('computeFuelSurchargeCents — CA', () => {
  it('returns 0/applied=false when the week price equals the trigger', async () => {
    fuel.push({ week_of: D('2026-06-29'), usd_per_gal: 5.05, source: 'eia_api' });
    const r = await computeFuelSurchargeCents({ siteId: CA, date: D('2026-07-03'), miles: 100 });
    expect(r.applied).toBe(false);
    expect(r.cents).toBe(0);
  });

  it('computes (price/mpg)*miles*100 rounded when above trigger', async () => {
    fuel.push({ week_of: D('2026-06-29'), usd_per_gal: 5.85, source: 'eia_api' });
    const r = await computeFuelSurchargeCents({ siteId: CA, date: D('2026-07-03'), miles: 100 });
    // (5.85 / 6.5) * 100 * 100 = 9000 cents = $90.00
    expect(r.applied).toBe(true);
    expect(r.cents).toBe(9000);
    expect(r.ref).toEqual({ rule_id: 'ca-fuel', fuel_price_week: '2026-06-29' });
  });

  it('throws MissingFuelPriceError when the week has no price on record', async () => {
    await expect(
      computeFuelSurchargeCents({ siteId: CA, date: D('2026-07-03'), miles: 100 }),
    ).rejects.toBeInstanceOf(MissingFuelPriceError);
  });
});

describe('computeFuelSurchargeCents — OR structural guard', () => {
  it('throws RuleStructurallyDisallowedError for an OR site before reading any price', async () => {
    fuel.push({ week_of: D('2026-06-29'), usd_per_gal: 5.85, source: 'eia_api' });
    await expect(
      computeFuelSurchargeCents({ siteId: OR, date: D('2026-07-03'), miles: 100 }),
    ).rejects.toBeInstanceOf(RuleStructurallyDisallowedError);
  });
});

describe('resolveFuelPrice', () => {
  it('reads the row keyed by the week Monday', async () => {
    fuel.push({ week_of: D('2026-06-29'), usd_per_gal: 5.42, source: 'manual' });
    const r = await resolveFuelPrice(D('2026-07-01'));
    expect(r.usdPerGal).toBe(5.42);
    expect(r.source).toBe('manual');
  });
});
