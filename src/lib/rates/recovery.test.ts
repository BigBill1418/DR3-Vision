import { describe, expect, it } from 'vitest';
import { recoveryRate } from './recovery';

describe('recoveryRate (by units, renovation-inclusive)', () => {
  it('credits the renovation channel into the numerator', () => {
    // (800 processed + 200 renovated) / (1000 + 0 landfilled) = 1.0
    const r = recoveryRate({ processedUnits: 800, renovatedWholeUnits: 200, landfilledUnits: 0 });
    expect(r.rate).toBeCloseTo(1, 10);
    expect(r.numerator).toBe(1000);
    expect(r.components['recovered']).toBe(1000);
  });

  it('rates recovered over recovered + landfilled', () => {
    // (700 + 100) / (800 + 200) = 0.8
    const r = recoveryRate({ processedUnits: 700, renovatedWholeUnits: 100, landfilledUnits: 200 });
    expect(r.rate).toBeCloseTo(0.8, 10);
    expect(r.denominator).toBe(1000);
    expect(r.estimatedInputs).toBe(false);
  });

  it('never sets estimatedInputs (units-based; the 55-lb estimate never enters)', () => {
    const r = recoveryRate({ processedUnits: 10, renovatedWholeUnits: 0, landfilledUnits: 5 });
    expect(r.estimatedInputs).toBe(false);
  });

  it('returns a typed no-data result on a zero denominator (not NaN)', () => {
    const r = recoveryRate({ processedUnits: 0, renovatedWholeUnits: 0, landfilledUnits: 0 });
    expect(r.noData).toBe(true);
    expect(r.rate).toBeNull();
    expect(Number.isNaN(r.rate as unknown as number)).toBe(false);
  });

  it('clamps negative inputs to zero', () => {
    const r = recoveryRate({ processedUnits: -5, renovatedWholeUnits: -2, landfilledUnits: -1 });
    expect(r.noData).toBe(true);
    expect(r.components['processedUnits']).toBe(0);
  });
});
