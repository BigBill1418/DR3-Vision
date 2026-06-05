import { describe, it, expect } from 'vitest';
import {
  calculateDailyBonus,
  calculateDailyBonusCents,
  calculateMonthlyBonusCents,
  formatCents,
  type BonusRuleParams,
} from './calculator';

// The corrected Woodland rule (ADR-0019 §1, T-101). threshold_high is 74, NOT 75.
const WOODLAND: BonusRuleParams = {
  threshold_low: 50,
  rate_low: 0.5,
  threshold_high: 74,
  rate_high: 0.25,
};

// Eugene rule (unchanged) — present so a future Eugene enablement has coverage.
const EUGENE: BonusRuleParams = {
  threshold_low: 50,
  rate_low: 1.0,
  threshold_high: 100,
  rate_high: 0.25,
};

describe('calculateDailyBonus — ADR-0019 §1 Woodland walk-through', () => {
  // These are the exact rows from the ADR-0019 §1 table and the T-101 acceptance.
  it('50 mattresses → $0.00 (qualifying day, no bonus)', () => {
    expect(calculateDailyBonus(50, WOODLAND)).toBe('$0.00');
    expect(calculateDailyBonusCents(50, WOODLAND)).toBe(0);
  });

  it('51 mattresses → $0.50', () => {
    expect(calculateDailyBonus(51, WOODLAND)).toBe('$0.50');
    expect(calculateDailyBonusCents(51, WOODLAND)).toBe(50);
  });

  it('74 mattresses → $12.00 (last low-tier mattress)', () => {
    expect(calculateDailyBonus(74, WOODLAND)).toBe('$12.00');
    expect(calculateDailyBonusCents(74, WOODLAND)).toBe(1200);
  });

  it('75 mattresses → $12.75 (the 75th earns the high-tier $0.75)', () => {
    expect(calculateDailyBonus(75, WOODLAND)).toBe('$12.75');
    expect(calculateDailyBonusCents(75, WOODLAND)).toBe(1275);
  });

  it('100 mattresses → $31.50', () => {
    expect(calculateDailyBonus(100, WOODLAND)).toBe('$31.50');
    expect(calculateDailyBonusCents(100, WOODLAND)).toBe(3150);
  });
});

describe('calculateDailyBonusCents — below threshold and edge cases', () => {
  it('returns 0 below the qualifying threshold', () => {
    expect(calculateDailyBonusCents(0, WOODLAND)).toBe(0);
    expect(calculateDailyBonusCents(1, WOODLAND)).toBe(0);
    expect(calculateDailyBonusCents(49, WOODLAND)).toBe(0);
  });

  it('treats negative / non-finite counts as 0', () => {
    expect(calculateDailyBonusCents(-5, WOODLAND)).toBe(0);
    expect(calculateDailyBonusCents(Number.NaN, WOODLAND)).toBe(0);
    expect(calculateDailyBonusCents(Number.POSITIVE_INFINITY, WOODLAND)).toBe(0);
  });

  it('floors fractional counts', () => {
    expect(calculateDailyBonusCents(74.9, WOODLAND)).toBe(1200);
  });

  it('accepts string rates (Prisma Decimal round-trips through toString)', () => {
    const stringRule: BonusRuleParams = {
      threshold_low: 50,
      rate_low: '0.5000',
      threshold_high: 74,
      rate_high: '0.2500',
    };
    expect(calculateDailyBonusCents(75, stringRule)).toBe(1275);
  });
});

describe('calculateDailyBonusCents — Eugene rule (unchanged)', () => {
  it('100 mattresses → $50.00 (high threshold not yet crossed)', () => {
    expect(calculateDailyBonusCents(100, EUGENE)).toBe(5000);
  });

  it('150 mattresses → $112.50', () => {
    // MAX(150-50,0)*$1.00 + MAX(150-100,0)*$0.25 = $100.00 + $12.50
    expect(calculateDailyBonusCents(150, EUGENE)).toBe(11250);
  });
});

describe('calculateMonthlyBonusCents', () => {
  it('sums daily bonuses across a month', () => {
    // 74 ($12.00) + 75 ($12.75) + 100 ($31.50) + 40 ($0.00) = $56.25
    expect(calculateMonthlyBonusCents([74, 75, 100, 40], WOODLAND)).toBe(5625);
  });

  it('an empty month is $0.00', () => {
    expect(calculateMonthlyBonusCents([], WOODLAND)).toBe(0);
  });
});

describe('formatCents', () => {
  it('formats whole and fractional dollars', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(1275)).toBe('$12.75');
    expect(formatCents(3150)).toBe('$31.50');
  });

  it('formats negative amounts (defensive — should not occur in normal use)', () => {
    expect(formatCents(-1275)).toBe('-$12.75');
  });
});
