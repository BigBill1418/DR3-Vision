// ADR-0037 D1 — state-program-rule resolver tests.
//
// DB-free: mocks `@/lib/prisma` with in-memory arrays (mirrors the bonus
// daily-entry test idiom). Drives the REAL resolver. Covers:
//   - strict effective-date resolution (latest effective_from wins; end-dated)
//   - NoActiveProgramRuleError when no row covers the date
//   - RuleStructurallyDisallowedError for OR fuel_surcharge (jurisdiction read
//     from the site row, never a hardcoded id) — and that CA fuel resolves
//   - fuel COMPUTATION refuses with a typed error (formula null AND captured)

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const sites: MockSite[] = [];
const rules: MockRule[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        sites.find((s) => s.id === where.id) ?? null,
    },
    stateProgramRule: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: {
          site_id: string;
          rule_kind: string;
          effective_from: { lte: Date };
          OR: Array<{ effective_to: null } | { effective_to: { gte: Date } }>;
        };
        orderBy: { effective_from: 'desc' };
      }) => {
        const matches = rules
          .filter(
            (r) =>
              r.site_id === where.site_id &&
              r.rule_kind === where.rule_kind &&
              r.effective_from.getTime() <= where.effective_from.lte.getTime() &&
              (r.effective_to === null ||
                r.effective_to.getTime() >= where.effective_from.lte.getTime()),
          )
          .sort((a, b) =>
            orderBy.effective_from === 'desc'
              ? b.effective_from.getTime() - a.effective_from.getTime()
              : a.effective_from.getTime() - b.effective_from.getTime(),
          );
        return matches[0] ?? null;
      },
    },
  },
}));

import {
  resolveProgramRule,
  resolveRateCents,
  computeFuelSurchargeCents,
  NoActiveProgramRuleError,
  RuleStructurallyDisallowedError,
  FuelSurchargeNotComputableError,
  type ResolvedProgramRule,
} from './resolver';

const CA = 'site-woodland';
const OR = 'site-eugene';
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(() => {
  sites.length = 0;
  rules.length = 0;
  sites.push({ id: CA, jurisdiction: 'california' }, { id: OR, jurisdiction: 'oregon' });
});

describe('resolveProgramRule — strict effective dating', () => {
  it('resolves the CA processing rate (1650¢) effective 2026-01-01', async () => {
    rules.push({
      id: 'r1',
      site_id: CA,
      rule_kind: 'processing_rate',
      effective_from: D('2026-01-01'),
      effective_to: null,
      rate_cents: 1650,
      params: null,
    });
    const r = await resolveProgramRule(CA, 'processing_rate', D('2026-07-03'));
    expect(r.rateCents).toBe(1650);
    expect(r.effectiveFrom).toEqual(D('2026-01-01'));
  });

  it('picks the latest effective_from when two rules overlap the date', async () => {
    rules.push(
      {
        id: 'old',
        site_id: CA,
        rule_kind: 'processing_rate',
        effective_from: D('2026-01-01'),
        effective_to: null,
        rate_cents: 1650,
        params: null,
      },
      {
        id: 'new',
        site_id: CA,
        rule_kind: 'processing_rate',
        effective_from: D('2026-06-01'),
        effective_to: null,
        rate_cents: 1725,
        params: null,
      },
    );
    const r = await resolveProgramRule(CA, 'processing_rate', D('2026-07-03'));
    expect(r.id).toBe('new');
    expect(r.rateCents).toBe(1725);
  });

  it('excludes a rule whose effective_to has passed', async () => {
    rules.push({
      id: 'expired',
      site_id: CA,
      rule_kind: 'processing_rate',
      effective_from: D('2025-01-01'),
      effective_to: D('2025-12-31'),
      rate_cents: 1600,
      params: null,
    });
    await expect(resolveProgramRule(CA, 'processing_rate', D('2026-07-03'))).rejects.toBeInstanceOf(
      NoActiveProgramRuleError,
    );
  });

  it('throws NoActiveProgramRuleError before the effective_from date', async () => {
    rules.push({
      id: 'future',
      site_id: CA,
      rule_kind: 'processing_rate',
      effective_from: D('2026-08-01'),
      effective_to: null,
      rate_cents: 1650,
      params: null,
    });
    await expect(resolveProgramRule(CA, 'processing_rate', D('2026-07-03'))).rejects.toBeInstanceOf(
      NoActiveProgramRuleError,
    );
  });

  it('throws NoActiveProgramRuleError for an unknown site', async () => {
    await expect(
      resolveProgramRule('nope', 'processing_rate', D('2026-07-03')),
    ).rejects.toBeInstanceOf(NoActiveProgramRuleError);
  });
});

describe('resolveRateCents — flat-rate helper', () => {
  it('returns the collector incentive rate (300¢)', async () => {
    rules.push({
      id: 'inc',
      site_id: CA,
      rule_kind: 'collector_incentive',
      effective_from: D('2026-01-01'),
      effective_to: null,
      rate_cents: 300,
      params: { daily_cap_units: 5 },
    });
    expect(await resolveRateCents(CA, 'collector_incentive', D('2026-07-03'))).toBe(300);
  });

  it('refuses (NoActiveProgramRuleError) when the resolved rule has no rate_cents', async () => {
    rules.push({
      id: 'norate',
      site_id: CA,
      rule_kind: 'processing_rate',
      effective_from: D('2026-01-01'),
      effective_to: null,
      rate_cents: null,
      params: null,
    });
    await expect(resolveRateCents(CA, 'processing_rate', D('2026-07-03'))).rejects.toBeInstanceOf(
      NoActiveProgramRuleError,
    );
  });
});

describe('OR fuel-surcharge structural disallow (layer 2 of 2)', () => {
  it('throws RuleStructurallyDisallowedError for an OR fuel lookup — even if a row exists', async () => {
    // Deliberately seed a (mistaken) OR fuel row to prove the resolver still refuses.
    rules.push({
      id: 'bad',
      site_id: OR,
      rule_kind: 'fuel_surcharge',
      effective_from: D('2026-01-01'),
      effective_to: null,
      rate_cents: 999,
      params: null,
    });
    await expect(resolveProgramRule(OR, 'fuel_surcharge', D('2026-07-03'))).rejects.toBeInstanceOf(
      RuleStructurallyDisallowedError,
    );
  });

  it('resolves a CA fuel-surcharge rule (jurisdiction-scoped, not id-scoped)', async () => {
    rules.push({
      id: 'cafuel',
      site_id: CA,
      rule_kind: 'fuel_surcharge',
      effective_from: D('2026-01-01'),
      effective_to: null,
      rate_cents: null,
      params: { formula: '(eia_rate_usd_per_gal / mpg) * miles_driven', mpg: 6.5 },
    });
    const r = await resolveProgramRule(CA, 'fuel_surcharge', D('2026-07-03'));
    expect(r.ruleKind).toBe('fuel_surcharge');
    expect(r.rateCents).toBeNull();
  });
});

describe('computeFuelSurchargeCents — always refuses in P1', () => {
  const base: ResolvedProgramRule = {
    id: 'x',
    siteId: CA,
    ruleKind: 'fuel_surcharge',
    effectiveFrom: D('2026-01-01'),
    effectiveTo: null,
    rateCents: null,
    params: null,
  };

  it('refuses with formula_pending when params.formula is null', () => {
    try {
      computeFuelSurchargeCents({ ...base, params: { formula: null } });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FuelSurchargeNotComputableError);
      expect((e as FuelSurchargeNotComputableError).reason).toBe('formula_pending');
    }
  });

  it('refuses with computation_not_implemented once the formula is captured', () => {
    try {
      computeFuelSurchargeCents({
        ...base,
        params: { formula: '(eia_rate_usd_per_gal / mpg) * miles_driven', mpg: 6.5 },
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FuelSurchargeNotComputableError);
      expect((e as FuelSurchargeNotComputableError).reason).toBe('computation_not_implemented');
    }
  });

  it('refuses for a non-fuel rule kind', () => {
    expect(() =>
      computeFuelSurchargeCents({ ...base, ruleKind: 'processing_rate' }),
    ).toThrow(FuelSurchargeNotComputableError);
  });
});
