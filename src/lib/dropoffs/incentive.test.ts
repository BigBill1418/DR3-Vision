// ADR-0037 D3 — drop-off incentive cap tests. Pure int math; the cap boundary
// and the multi-drop-off-same-person-same-day case are the acceptance edges.

import { describe, it, expect } from 'vitest';
import { computeDropoffIncentive, paidUnitsFromIncentiveCents } from './incentive';

// CA collector incentive: 300¢/unit, daily cap 5 units/person/day (seed values).
const RATE = 300;
const CAP = 5;
const base = { rateCents: RATE, dailyCapUnits: CAP, priorPaidUnitsToday: 0 };

describe('computeDropoffIncentive — under, at, and over the cap', () => {
  it('pays the full amount below the cap (3 units → 900¢)', () => {
    const r = computeDropoffIncentive({ ...base, units: 3 });
    expect(r).toEqual({ paidUnits: 3, cappedUnits: 0, incentiveCents: 900 });
  });

  it('exactly at the cap (5 units → 1500¢, remaining cap now 0)', () => {
    const r = computeDropoffIncentive({ ...base, units: 5 });
    expect(r).toEqual({ paidUnits: 5, cappedUnits: 0, incentiveCents: 1500 });
  });

  it('over the cap in a single drop-off (7 units → pays 5, caps 2)', () => {
    const r = computeDropoffIncentive({ ...base, units: 7 });
    expect(r).toEqual({ paidUnits: 5, cappedUnits: 2, incentiveCents: 1500 });
  });
});

describe('cap is per-person-per-day across multiple drop-offs', () => {
  it('second drop-off same day only pays the remainder (3 then 4 → 5 paid total)', () => {
    const first = computeDropoffIncentive({ ...base, units: 3 });
    expect(first.paidUnits).toBe(3);
    const second = computeDropoffIncentive({
      ...base,
      units: 4,
      priorPaidUnitsToday: first.paidUnits,
    });
    // Only 2 of the afternoon's 4 fall under the remaining cap (5 − 3).
    expect(second).toEqual({ paidUnits: 2, cappedUnits: 2, incentiveCents: 600 });
    expect(first.paidUnits + second.paidUnits).toBe(CAP);
  });

  it('third drop-off after the cap is exhausted pays nothing', () => {
    const r = computeDropoffIncentive({ ...base, units: 4, priorPaidUnitsToday: 5 });
    expect(r).toEqual({ paidUnits: 0, cappedUnits: 4, incentiveCents: 0 });
  });

  it('a DIFFERENT person the same day starts fresh (priorPaidUnitsToday = 0)', () => {
    const r = computeDropoffIncentive({ ...base, units: 5, priorPaidUnitsToday: 0 });
    expect(r.paidUnits).toBe(5);
    expect(r.incentiveCents).toBe(1500);
  });

  it('the SAME person a different day starts fresh (priorPaidUnitsToday = 0)', () => {
    const r = computeDropoffIncentive({ ...base, units: 5, priorPaidUnitsToday: 0 });
    expect(r.paidUnits).toBe(5);
  });
});

describe('computeDropoffIncentive — invariants and guards', () => {
  it('paidUnits + cappedUnits always equals input units', () => {
    for (let units = 0; units <= 12; units++) {
      for (let prior = 0; prior <= 7; prior++) {
        const r = computeDropoffIncentive({ ...base, units, priorPaidUnitsToday: prior });
        expect(r.paidUnits + r.cappedUnits).toBe(units);
        expect(r.incentiveCents).toBe(r.paidUnits * RATE);
        expect(r.paidUnits).toBeLessThanOrEqual(Math.max(CAP - prior, 0));
      }
    }
  });

  it('zero units → zero incentive', () => {
    expect(computeDropoffIncentive({ ...base, units: 0 })).toEqual({
      paidUnits: 0,
      cappedUnits: 0,
      incentiveCents: 0,
    });
  });

  it('throws on a fractional unit count', () => {
    expect(() => computeDropoffIncentive({ ...base, units: 2.5 })).toThrow(TypeError);
  });

  it('throws on a negative prior', () => {
    expect(() => computeDropoffIncentive({ ...base, units: 3, priorPaidUnitsToday: -1 })).toThrow(
      TypeError,
    );
  });
});

describe('paidUnitsFromIncentiveCents — exact recovery of prior paid units', () => {
  it('recovers paid units from stored incentive cents', () => {
    expect(paidUnitsFromIncentiveCents(900, RATE)).toBe(3);
    expect(paidUnitsFromIncentiveCents(1500, RATE)).toBe(5);
  });

  it('returns 0 for null / zero incentive', () => {
    expect(paidUnitsFromIncentiveCents(null, RATE)).toBe(0);
    expect(paidUnitsFromIncentiveCents(undefined, RATE)).toBe(0);
    expect(paidUnitsFromIncentiveCents(0, RATE)).toBe(0);
  });

  it('throws when the stored cents are not divisible by the rate', () => {
    expect(() => paidUnitsFromIncentiveCents(950, RATE)).toThrow(RangeError);
  });

  it('throws on a non-positive rate', () => {
    expect(() => paidUnitsFromIncentiveCents(900, 0)).toThrow(TypeError);
  });
});
