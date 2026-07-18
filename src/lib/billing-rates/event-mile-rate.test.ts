// ADR-0040 amendment (§3.7) — Event Mile Rate resolver over the CA tier set. Pure:
// exercises band boundaries (the exact 25/50/100 edges) and the fail-loud out-of-range
// error. The seven bands are the real seeded CA `transport_rate_tiers` set.

import { describe, it, expect } from 'vitest';
import { resolveEventMileRateCents, EventMileRateOutOfRangeError } from './event-mile-rate';
import type { ProposedTier } from './tier-validation';

// The real CA Event Mile Rate table (= seeded transport_rate_tiers CA, Variables!D6:F13).
const CA_EVENT_MILE_TIERS: ProposedTier[] = [
  { min_miles: 0, max_miles: 25, rate_cents: 42500 },
  { min_miles: 26, max_miles: 50, rate_cents: 60000 },
  { min_miles: 51, max_miles: 100, rate_cents: 92500 },
  { min_miles: 101, max_miles: 200, rate_cents: 145000 },
  { min_miles: 201, max_miles: 300, rate_cents: 200000 },
  { min_miles: 301, max_miles: 400, rate_cents: 250000 },
  { min_miles: 401, max_miles: 500, rate_cents: 300000 },
];

describe('resolveEventMileRateCents — band mapping', () => {
  it('maps representative mileages to their band rate', () => {
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 0)).toBe(42500);
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 40)).toBe(60000);
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 150)).toBe(145000);
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 500)).toBe(300000);
  });

  it('resolves the exact 25 / 26 / 50 / 51 / 100 / 101 boundary miles to the correct side', () => {
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 25)).toBe(42500); // top of band 1
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 26)).toBe(60000); // bottom of band 2
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 50)).toBe(60000); // top of band 2
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 51)).toBe(92500); // bottom of band 3
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 100)).toBe(92500); // top of band 3
    expect(resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 101)).toBe(145000); // bottom of band 4
  });
});

describe('resolveEventMileRateCents — fail loud (never a silent $0)', () => {
  it('throws when mileage exceeds the top band (> 500)', () => {
    try {
      resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 501);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EventMileRateOutOfRangeError);
      expect((e as EventMileRateOutOfRangeError).miles).toBe(501);
      expect((e as EventMileRateOutOfRangeError).context).toEqual({ min_miles: 0, max_miles: 500 });
    }
  });

  it('throws for negative or non-integer mileage', () => {
    expect(() => resolveEventMileRateCents(CA_EVENT_MILE_TIERS, -1)).toThrow(
      EventMileRateOutOfRangeError,
    );
    expect(() => resolveEventMileRateCents(CA_EVENT_MILE_TIERS, 40.5)).toThrow(
      EventMileRateOutOfRangeError,
    );
  });

  it('throws on an empty tier set (no bands to cover any mileage)', () => {
    expect(() => resolveEventMileRateCents([], 40)).toThrow(EventMileRateOutOfRangeError);
  });
});
