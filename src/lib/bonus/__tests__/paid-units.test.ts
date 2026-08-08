// ADR-0083 — the paid-unit policy, pinned.
//
// These tests exist because the WRONG model (bonus computed on each column
// separately) is the one a reasonable person reaches for, and it fails silently:
// it pays $0 rather than throwing, so nothing in the system would have
// complained. The sub-threshold-crossing case below is the one that catches it.

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';
import {
  dailyPaidUnits,
  dailyBonusCentsFor,
  periodBonusCentsFor,
  toUnitCount,
} from '@/lib/bonus/paid-units';

// The real Woodland rule (ADR-0019 §1): mattresses 51–74 earn $0.50, 75+ earn
// $0.75. Not a convenient fixture — the numbers below are only meaningful
// against the actual thresholds.
const WOODLAND = {
  threshold_low: 50,
  rate_low: '0.50',
  threshold_high: 74,
  rate_high: '0.25',
};

/** A genuine Prisma Decimal, not a number wearing a Decimal's name. */
const dec = (n: number) => new Prisma.Decimal(n);

describe('dailyPaidUnits', () => {
  it('sums processed and saved units', () => {
    expect(dailyPaidUnits({ mattress_count: dec(40), saves: dec(20) })).toBe(60);
  });

  it('coerces REAL Prisma Decimals, not just numbers', () => {
    // The 2026-06 incident was a Decimal reaching the calculator un-coerced.
    // Asserting with real Decimal objects is the whole point; a number fixture
    // here would pass while the production path stayed broken.
    const row = { mattress_count: dec(60.5), saves: dec(3.5) };
    expect(row.mattress_count).toBeInstanceOf(Prisma.Decimal);
    expect(dailyPaidUnits(row)).toBe(64);
  });

  it('treats an absent saves as 0 without throwing', () => {
    expect(dailyPaidUnits({ mattress_count: dec(10) })).toBe(10);
    expect(dailyPaidUnits({ mattress_count: dec(10), saves: null })).toBe(10);
  });
});

describe('toUnitCount', () => {
  it('names the offending column when coercion fails', () => {
    // A message that says only "did not coerce" leaves you bisecting a payroll
    // path; it must name which of the two columns was wrong.
    expect(() => toUnitCount({ toNumber: () => NaN }, 'saves')).toThrow(/saves/);
    expect(() => toUnitCount({ toNumber: () => NaN }, 'mattress_count')).toThrow(/mattress_count/);
  });
});

describe('the tier threshold applies ONCE to the combined total', () => {
  it('pays a day whose columns are each sub-threshold but together are not', () => {
    // 40 processed + 20 saved = 60 paid units → (60-50) * $0.50 = $5.00.
    //
    // THIS IS THE FALSIFICATION OF THE WRONG MODEL. Computing the two columns
    // separately gives bonus(40) + bonus(20) = $0.00 + $0.00 = nothing, because
    // each column sits under the 50-unit threshold on its own. That model does
    // not throw, does not warn, and would have meant "we shipped a saves column
    // and nobody was ever paid for a save" for every processor whose split
    // straddled the threshold — which is most of them.
    const row = { mattress_count: dec(40), saves: dec(20) };

    expect(dailyBonusCentsFor(row, WOODLAND)).toBe(500);

    const wrongSeparateModel =
      calculateDailyBonusCents(40, WOODLAND) + calculateDailyBonusCents(20, WOODLAND);
    expect(wrongSeparateModel).toBe(0);
    expect(dailyBonusCentsFor(row, WOODLAND)).not.toBe(wrongSeparateModel);
  });

  it('does not grant a second threshold allowance', () => {
    // 60 processed + 60 saved = 120 paid units.
    //   correct : (120-50)*0.50 + (120-74)*0.25 = $35.00 + $11.50 = $46.50
    //   separate: 2 * ((60-50)*0.50)            = $10.00
    // The separate model is not merely different, it under-pays by $36.50 on a
    // single day for a single processor.
    const row = { mattress_count: dec(60), saves: dec(60) };
    expect(dailyBonusCentsFor(row, WOODLAND)).toBe(4650);
    expect(2 * calculateDailyBonusCents(60, WOODLAND)).toBe(1000);
  });

  it('pays a saves-only day exactly as it would the same processed count', () => {
    // A processor who spent the shift pulling units for resale has a real day.
    const savesOnly = { mattress_count: dec(0), saves: dec(80) };
    const processedOnly = { mattress_count: dec(80), saves: dec(0) };
    expect(dailyBonusCentsFor(savesOnly, WOODLAND)).toBe(
      dailyBonusCentsFor(processedOnly, WOODLAND),
    );
    expect(dailyBonusCentsFor(savesOnly, WOODLAND)).toBe(1650);
  });
});

describe('periodBonusCentsFor', () => {
  it('tiers each DAY separately, never the period sum', () => {
    // Three 30-unit days is three sub-threshold days = $0, NOT one 90-unit day.
    // If the period total were tiered once, this would wrongly pay $24.00.
    const rows = [
      { mattress_count: dec(20), saves: dec(10) },
      { mattress_count: dec(20), saves: dec(10) },
      { mattress_count: dec(20), saves: dec(10) },
    ];
    expect(periodBonusCentsFor(rows, WOODLAND)).toBe(0);
    expect(calculateDailyBonusCents(90, WOODLAND)).toBe(2400);
  });

  it('is byte-identical to the pre-ADR-0083 formula when every saves is 0', () => {
    // The historical-parity property the whole migration rests on. See
    // saves-historical-reconcile.test.ts for the reconcile-level version.
    const counts = [55, 76, 40, 120, 0, 74, 75];
    const rows = counts.map((c) => ({ mattress_count: dec(c), saves: dec(0) }));
    const legacy = counts.reduce((s, c) => s + calculateDailyBonusCents(c, WOODLAND), 0);
    expect(periodBonusCentsFor(rows, WOODLAND)).toBe(legacy);
  });
});
