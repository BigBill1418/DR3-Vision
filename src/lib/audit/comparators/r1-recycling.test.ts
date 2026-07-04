import { describe, expect, it } from 'vitest';
import { recyclingRate } from '@/lib/rates';
import { r1RecyclingRate } from './r1-recycling';
import { gradeRate, type RateThresholds } from './rate-check';
import { toCheckConfig } from '../config';
import { DEFAULT_CHECK_CONFIGS } from '../config';
import type { AuditWindow, CheckConfig } from '../types';

const CONFIG: CheckConfig = toCheckConfig(
  DEFAULT_CHECK_CONFIGS.find((c) => c.checkCode === 'r1_recycling_rate')!,
);
const WINDOW: AuditWindow = { siteId: 'woodland', startISO: '2025-10-01', endISO: '2026-07-01', asOfISO: '2026-07-01' };
// CA floor 75, warn +3 (=78), high +1 (=76).
const CA: RateThresholds = { floorPct: 75, warnMarginPts: 3, highMarginPts: 1 };

/** A recycling input hitting an exact target percent via one commodity + trash. */
function rateAt(pct: number) {
  // recycled = pct, disposed(trash) = 100 - pct → rate = pct/100.
  return recyclingRate({
    outbound: [
      { commodity: 'foam', weightLbs: pct },
      { commodity: 'trash', weightLbs: 100 - pct },
    ],
    landfilledUnits: 0,
  });
}

describe('gradeRate boundary at floor + margin', () => {
  it('no breach exactly at floor + warn margin (78%)', () => {
    expect(gradeRate(rateAt(78), CA).breached).toBe(false);
  });
  it('warns (medium) just below warn but at/above high threshold (77%)', () => {
    const g = gradeRate(rateAt(77), CA);
    expect(g.breached).toBe(true);
    expect(g.severity).toBe('medium');
  });
  it('medium exactly at high threshold (76%) — high requires strictly below', () => {
    const g = gradeRate(rateAt(76), CA);
    expect(g.breached).toBe(true);
    expect(g.severity).toBe('medium');
  });
  it('high just below the high threshold (75%)', () => {
    const g = gradeRate(rateAt(75), CA);
    expect(g.breached).toBe(true);
    expect(g.severity).toBe('high');
  });
  it('no breach on no-data', () => {
    const g = gradeRate(recyclingRate({ outbound: [], landfilledUnits: 0 }), CA);
    expect(g.breached).toBe(false);
    expect(g.ratePct).toBeNull();
  });
});

describe('r1RecyclingRate comparator', () => {
  it('emits one window-normalized finding on breach, keyed on site only', () => {
    const findings = r1RecyclingRate(WINDOW, rateAt(74), CONFIG, CA, 'california');
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.checkCode).toBe('r1_recycling_rate');
    expect(f.severity).toBe('high');
    expect(f.fingerprint).toBe('r1_recycling_rate|value_mismatch|woodland');
    expect((f.detail as { estimated: boolean }).estimated).toBe(false);
    expect((f.detail as { metric: string }).metric).toBe('recycling_rate');
  });

  it('carries the estimated marker when landfilled units contributed', () => {
    const rate = recyclingRate({ outbound: [{ commodity: 'foam', weightLbs: 700 }], landfilledUnits: 20 });
    const findings = r1RecyclingRate(WINDOW, rate, CONFIG, CA, 'california');
    expect(findings).toHaveLength(1);
    expect((findings[0]!.detail as { estimated: boolean }).estimated).toBe(true);
  });

  it('emits nothing when the rate is healthy or has no data', () => {
    expect(r1RecyclingRate(WINDOW, rateAt(90), CONFIG, CA, 'california')).toHaveLength(0);
    expect(
      r1RecyclingRate(WINDOW, recyclingRate({ outbound: [], landfilledUnits: 0 }), CONFIG, CA, 'california'),
    ).toHaveLength(0);
  });

  it('a persisting low rate maps to the SAME fingerprint across shifting windows', () => {
    const a = r1RecyclingRate(WINDOW, rateAt(70), CONFIG, CA, 'california')[0]!;
    const later: AuditWindow = { ...WINDOW, startISO: '2025-10-08', endISO: '2026-07-08', asOfISO: '2026-07-08' };
    const b = r1RecyclingRate(later, rateAt(70), CONFIG, CA, 'california')[0]!;
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
