// ADR-0040 D1 — tier-set validation tests. Pure (no DB, no mocks). Covers the
// CA seed set (valid), plus each defect class naming the offending row(s).

import { describe, it, expect } from 'vitest';
import {
  validateTierSet,
  assertValidTierSet,
  tierForMiles,
  TierSetInvalidError,
  type ProposedTier,
} from './tier-validation';

// The CA table from ADR-0040 D1 (effective 2026-01-01) — the canonical valid set.
const CA_SEED: ProposedTier[] = [
  { min_miles: 0, max_miles: 25, rate_cents: 42500 },
  { min_miles: 26, max_miles: 50, rate_cents: 60000 },
  { min_miles: 51, max_miles: 100, rate_cents: 92500 },
  { min_miles: 101, max_miles: 200, rate_cents: 145000 },
  { min_miles: 201, max_miles: 300, rate_cents: 200000 },
  { min_miles: 301, max_miles: 400, rate_cents: 250000 },
  { min_miles: 401, max_miles: 500, rate_cents: 300000 },
];

describe('validateTierSet — valid sets', () => {
  it('accepts the ADR-0040 CA seed table', () => {
    expect(validateTierSet(CA_SEED)).toEqual([]);
  });

  it('is order-independent (shuffled input still valid)', () => {
    const shuffled = [CA_SEED[3]!, CA_SEED[0]!, CA_SEED[6]!, CA_SEED[1]!, CA_SEED[5]!, CA_SEED[2]!, CA_SEED[4]!];
    expect(validateTierSet(shuffled)).toEqual([]);
  });

  it('accepts a single band starting at 0', () => {
    expect(validateTierSet([{ min_miles: 0, max_miles: 50, rate_cents: 10000 }])).toEqual([]);
  });
});

describe('validateTierSet — structural defects', () => {
  it('flags an empty set', () => {
    expect(validateTierSet([])).toEqual([{ kind: 'empty_set' }]);
  });

  it('flags a set that does not start at zero, naming the offending row', () => {
    const problems = validateTierSet([
      { min_miles: 1, max_miles: 25, rate_cents: 42500 },
      { min_miles: 26, max_miles: 50, rate_cents: 60000 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'must_start_at_zero', min_miles: 1 });
    expect((problems[0] as { row: { index: number } }).row.index).toBe(0);
  });

  it('flags a gap between two bands, naming both rows and the expected min', () => {
    const problems = validateTierSet([
      { min_miles: 0, max_miles: 25, rate_cents: 42500 },
      { min_miles: 30, max_miles: 50, rate_cents: 60000 }, // gap: 26..29 uncovered
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'gap', expected_min: 26, actual_min: 30 });
  });

  it('flags an overlap between two bands', () => {
    const problems = validateTierSet([
      { min_miles: 0, max_miles: 30, rate_cents: 42500 },
      { min_miles: 26, max_miles: 50, rate_cents: 60000 }, // overlaps 26..30
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'overlap', overlap_at: 26 });
  });

  it('flags inverted bounds (min > max)', () => {
    const problems = validateTierSet([{ min_miles: 50, max_miles: 25, rate_cents: 42500 }]);
    expect(problems.some((p) => p.kind === 'inverted_bounds')).toBe(true);
  });

  it('flags a non-positive rate', () => {
    const problems = validateTierSet([{ min_miles: 0, max_miles: 25, rate_cents: 0 }]);
    expect(problems.some((p) => p.kind === 'non_positive_rate')).toBe(true);
  });

  it('flags a non-integer bound and stops before adjacency math', () => {
    const problems = validateTierSet([{ min_miles: 0, max_miles: 25.5, rate_cents: 42500 }]);
    expect(problems.some((p) => p.kind === 'non_integer_bound')).toBe(true);
    expect(problems.some((p) => p.kind === 'gap' || p.kind === 'overlap')).toBe(false);
  });

  it('reports both a gap and an overlap in a larger malformed set', () => {
    const problems = validateTierSet([
      { min_miles: 0, max_miles: 25, rate_cents: 42500 },
      { min_miles: 26, max_miles: 60, rate_cents: 60000 },
      { min_miles: 51, max_miles: 100, rate_cents: 92500 }, // overlap (51 < 61)
      { min_miles: 150, max_miles: 200, rate_cents: 145000 }, // gap (expected 101)
    ]);
    expect(problems.some((p) => p.kind === 'overlap')).toBe(true);
    expect(problems.some((p) => p.kind === 'gap')).toBe(true);
  });
});

describe('assertValidTierSet', () => {
  it('does not throw on the CA seed', () => {
    expect(() => assertValidTierSet(CA_SEED)).not.toThrow();
  });

  it('throws TierSetInvalidError carrying the problem list', () => {
    try {
      assertValidTierSet([{ min_miles: 5, max_miles: 25, rate_cents: 42500 }]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TierSetInvalidError);
      expect((e as TierSetInvalidError).problems[0]!.kind).toBe('must_start_at_zero');
      expect((e as TierSetInvalidError).status).toBe(422);
    }
  });
});

describe('tierForMiles', () => {
  it('resolves boundary miles 25 and 26 to adjacent bands', () => {
    expect(tierForMiles(CA_SEED, 25)?.rate_cents).toBe(42500);
    expect(tierForMiles(CA_SEED, 26)?.rate_cents).toBe(60000);
  });

  it('returns null above the top band', () => {
    expect(tierForMiles(CA_SEED, 501)).toBeNull();
  });
});
