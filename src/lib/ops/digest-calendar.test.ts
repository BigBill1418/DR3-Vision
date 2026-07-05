import { describe, expect, it } from 'vitest';
import {
  isBoardPackDay,
  isWeeklyGenerationDay,
  previousMonthEnd,
  previousMonthStart,
  previousWeekRange,
  secondWednesdayOfMonth,
} from './digest-calendar';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('isWeeklyGenerationDay (Monday)', () => {
  it('is true only on a Monday', () => {
    expect(isWeeklyGenerationDay(day('2026-07-06'))).toBe(true); // Mon
    expect(isWeeklyGenerationDay(day('2026-07-07'))).toBe(false); // Tue
    expect(isWeeklyGenerationDay(day('2026-07-05'))).toBe(false); // Sun
  });
});

describe('previousWeekRange', () => {
  it('returns the prior Mon–Sun for a Monday', () => {
    const { start, end } = previousWeekRange(day('2026-07-06'));
    expect(iso(start)).toBe('2026-06-29'); // prior Monday
    expect(iso(end)).toBe('2026-07-05'); // prior Sunday
  });
});

describe('secondWednesdayOfMonth (matrix incl. month edges)', () => {
  it.each([
    [2026, 0, 14], // Jan 2026 → the 14th
    [2026, 1, 11], // Feb 2026 → the 11th
    [2026, 6, 8], // Jul 2026 → the 8th (1st is a Wednesday — earliest possible)
    [2026, 11, 9], // Dec 2026 → the 9th
    [2027, 0, 13], // Jan 2027 → the 13th
  ])('year %i month0 %i → day %i', (y, m0, expected) => {
    expect(secondWednesdayOfMonth(y, m0)).toBe(expected);
  });
});

describe('isBoardPackDay (2nd Wednesday + preceding Monday)', () => {
  it.each([
    // [date, expected]
    ['2026-07-08', true], // 2nd Wednesday
    ['2026-07-06', true], // preceding Monday
    ['2026-07-07', false], // Tuesday between — NOT a gen day
    ['2026-07-01', false], // 1st Wednesday
    ['2026-07-15', false], // 3rd Wednesday
    ['2026-01-14', true], // Jan 2nd Wed (14th)
    ['2026-01-12', true], // Jan preceding Monday (12th)
    ['2026-12-09', true], // Dec 2nd Wed
    ['2026-12-07', true], // Dec preceding Monday
  ])('%s → %s', (d, expected) => {
    expect(isBoardPackDay(day(d))).toBe(expected);
  });
});

describe('previousMonth bounds', () => {
  it('July → June 1..30', () => {
    expect(iso(previousMonthStart(day('2026-07-06')))).toBe('2026-06-01');
    expect(iso(previousMonthEnd(day('2026-07-06')))).toBe('2026-06-30');
  });
  it('January → prior December (year rollover)', () => {
    expect(iso(previousMonthStart(day('2027-01-11')))).toBe('2026-12-01');
    expect(iso(previousMonthEnd(day('2027-01-11')))).toBe('2026-12-31');
  });
});
