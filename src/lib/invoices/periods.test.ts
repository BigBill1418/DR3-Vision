import { describe, expect, it } from 'vitest';
import { billingMonthStartISO, midMonthWindow, monthWindow, windowForKind } from './periods';

describe('billing windows', () => {
  it('monthWindow spans 1st..last day (30-day June)', () => {
    expect(monthWindow('2026-06-01')).toEqual({ startISO: '2026-06-01', endISO: '2026-06-30' });
  });

  it('monthWindow handles 31-day + February', () => {
    expect(monthWindow('2026-07-01').endISO).toBe('2026-07-31');
    expect(monthWindow('2026-02-01').endISO).toBe('2026-02-28');
    expect(monthWindow('2028-02-01').endISO).toBe('2028-02-29'); // leap
  });

  it('midMonthWindow is 1st..15th INCLUSIVE (Jun 15/16 boundary)', () => {
    const w = midMonthWindow('2026-06-01');
    expect(w).toEqual({ startISO: '2026-06-01', endISO: '2026-06-15' });
    // the 16th is outside the mid-month window by construction
    expect(w.endISO < '2026-06-16').toBe(true);
  });

  it('billingMonthStartISO normalizes any day to first-of-month', () => {
    expect(billingMonthStartISO('2026-06-17')).toBe('2026-06-01');
    expect(billingMonthStartISO('2026-06-30')).toBe('2026-06-01');
  });

  it('windowForKind: mid-month kind → 1st–15th; all others → whole month', () => {
    expect(windowForKind('ca_processing_mid_month', '2026-06-17')).toEqual({
      startISO: '2026-06-01',
      endISO: '2026-06-15',
    });
    expect(windowForKind('ca_processing_eom', '2026-06-17')).toEqual({
      startISO: '2026-06-01',
      endISO: '2026-06-30',
    });
    expect(windowForKind('or_transportation_eom', '2026-06-01').endISO).toBe('2026-06-30');
  });
});
