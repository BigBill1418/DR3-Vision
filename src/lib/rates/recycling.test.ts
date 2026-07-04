import { describe, expect, it } from 'vitest';
import { recyclingRate } from './recycling';
import { UNIT_WEIGHT_ESTIMATE_LBS } from './types';

describe('recyclingRate (by weight)', () => {
  it('rates non-trash weight over total (no landfill, no estimate)', () => {
    const r = recyclingRate({
      outbound: [
        { commodity: 'foam', weightLbs: 700 },
        { commodity: 'metal', weightLbs: 300 },
        { commodity: 'trash', weightLbs: 250 },
      ],
      landfilledUnits: 0,
    });
    expect(r.noData).toBe(false);
    expect(r.numerator).toBe(1000); // 700 + 300
    expect(r.denominator).toBe(1250); // + 250 trash
    expect(r.rate).toBeCloseTo(0.8, 10);
    expect(r.estimatedInputs).toBe(false);
    expect(r.components['trashLbs']).toBe(250);
  });

  it('counts trash as DISPOSED even for a WTE-style vendor (conservative, B10-5 pending)', () => {
    // All trash → rate is depressed (under-counts → early alert, never late).
    const r = recyclingRate({
      outbound: [
        { commodity: 'foam', weightLbs: 900 },
        { commodity: 'trash', weightLbs: 100 },
      ],
      landfilledUnits: 0,
    });
    expect(r.rate).toBeCloseTo(0.9, 10);
    expect(r.estimatedInputs).toBe(false);
  });

  it('adds landfilled units × 55 lb to the disposed side and flags estimatedInputs', () => {
    // recycled 900; disposed = 0 trash + 10*55 = 550 → 900/1450.
    const r = recyclingRate({
      outbound: [{ commodity: 'shoddy', weightLbs: 900 }],
      landfilledUnits: 10,
    });
    expect(r.estimatedInputs).toBe(true);
    expect(r.components['landfilledLbs']).toBe(10 * UNIT_WEIGHT_ESTIMATE_LBS);
    expect(r.denominator).toBe(1450);
    expect(r.rate).toBeCloseTo(900 / 1450, 10);
  });

  it('honours a custom unit-weight estimate override', () => {
    const r = recyclingRate({
      outbound: [{ commodity: 'foam', weightLbs: 100 }],
      landfilledUnits: 2,
      unitWeightEstimateLbs: 40,
    });
    expect(r.components['landfilledLbs']).toBe(80);
    expect(r.denominator).toBe(180);
  });

  it('treats null weights as zero without throwing', () => {
    const r = recyclingRate({
      outbound: [
        { commodity: 'foam', weightLbs: null },
        { commodity: 'trash', weightLbs: null },
      ],
      landfilledUnits: 0,
    });
    expect(r.noData).toBe(true);
    expect(r.rate).toBeNull();
  });

  it('returns a typed no-data result (not NaN) on a zero denominator', () => {
    const r = recyclingRate({ outbound: [], landfilledUnits: 0 });
    expect(r.noData).toBe(true);
    expect(r.rate).toBeNull();
    expect(Number.isNaN(r.rate as unknown as number)).toBe(false);
    expect(r.denominator).toBe(0);
  });

  it('never lets a negative landfilled count invert the estimate', () => {
    const r = recyclingRate({ outbound: [{ commodity: 'foam', weightLbs: 100 }], landfilledUnits: -5 });
    expect(r.components['landfilledUnits']).toBe(0);
    expect(r.estimatedInputs).toBe(false);
    expect(r.denominator).toBe(100);
  });
});
