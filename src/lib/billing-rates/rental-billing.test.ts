// ADR-0040 amendment (§3.6, C-10) — container rentals are NEVER prorated. Pure: proves the
// boundary-spanning case (a rental that starts on the 28th and runs open-ended bills the
// FULL monthly rate in BOTH the start month and the next month), plus the overlap edges.

import { describe, it, expect } from 'vitest';
import {
  monthWindowUTC,
  rentalOverlapsMonth,
  billedRentalCents,
  type RentalPeriod,
} from './rental-billing';

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('monthWindowUTC', () => {
  it('returns the 1st and last day of the month containing any day', () => {
    const jan = monthWindowUTC(D('2026-01-28'));
    expect(jan.monthStart.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(jan.monthEnd.toISOString().slice(0, 10)).toBe('2026-01-31');
    // February 2026 (non-leap) ends on the 28th.
    const feb = monthWindowUTC(D('2026-02-15'));
    expect(feb.monthEnd.toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

describe('rentalOverlapsMonth — never prorate (full month for any overlap)', () => {
  // A rental starting on the 28th, open-ended.
  const spanning: RentalPeriod = {
    effective_from: D('2026-01-28'),
    effective_to: null,
    monthly_rate_cents: 60000,
  };

  it('bills the FULL rate in the START month (Jan) even though it began on the 28th', () => {
    const jan = monthWindowUTC(D('2026-01-15'));
    expect(rentalOverlapsMonth(spanning, jan)).toBe(true);
    expect(billedRentalCents(spanning)).toBe(60000); // full, not 4/31 of it
  });

  it('bills the FULL rate AGAIN in the NEXT month (Feb) — charged in BOTH months', () => {
    const feb = monthWindowUTC(D('2026-02-15'));
    expect(rentalOverlapsMonth(spanning, feb)).toBe(true);
    expect(billedRentalCents(spanning)).toBe(60000);
  });

  it('excludes a month entirely before the rental started', () => {
    const dec = monthWindowUTC(D('2025-12-15'));
    expect(rentalOverlapsMonth(spanning, dec)).toBe(false);
  });

  it('includes the exact effective_to month and excludes the month after it', () => {
    const ended: RentalPeriod = {
      effective_from: D('2026-01-01'),
      effective_to: D('2026-03-05'),
      monthly_rate_cents: 30000,
    };
    // March overlaps (ends on the 5th) → full month billed.
    expect(rentalOverlapsMonth(ended, monthWindowUTC(D('2026-03-20')))).toBe(true);
    // April is after the end → excluded.
    expect(rentalOverlapsMonth(ended, monthWindowUTC(D('2026-04-10')))).toBe(false);
  });

  it('billedRentalCents is always the full monthly rate, never a day fraction', () => {
    expect(billedRentalCents({ monthly_rate_cents: 120000 })).toBe(120000);
    expect(billedRentalCents({ monthly_rate_cents: 1 })).toBe(1);
  });
});
