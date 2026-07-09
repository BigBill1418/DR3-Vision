// ADR-0049 D2 — business-hours predicate tests, incl. the DST proof (test-plan
// line 2: "poll skips outside business hours").

import { describe, expect, it } from 'vitest';
import { isBusinessHours, pacificClock } from './business-hours';

describe('isBusinessHours (6 AM–8 PM PT, Mon-Fri)', () => {
  it('is true mid-morning on a summer weekday (PDT)', () => {
    // 2026-06-01 is a Monday; 17:00Z = 10:00 PDT.
    expect(isBusinessHours(new Date('2026-06-01T17:00:00Z'))).toBe(true);
  });

  it('is false before 6 AM on a weekday', () => {
    // 12:00Z = 05:00 PDT Monday.
    expect(isBusinessHours(new Date('2026-06-01T12:00:00Z'))).toBe(false);
  });

  it('is false at/after 8 PM (exclusive close)', () => {
    // 03:00Z Tue = 20:00 PDT Monday.
    expect(isBusinessHours(new Date('2026-06-02T03:00:00Z'))).toBe(false);
  });

  it('is false on a weekend even during the day', () => {
    // 2026-06-06 is a Saturday; 18:00Z = 11:00 PDT.
    expect(isBusinessHours(new Date('2026-06-06T18:00:00Z'))).toBe(false);
  });

  it('respects DST: 13:30Z is 06:30 PDT (in) in summer but 05:30 PST (out) in winter', () => {
    expect(isBusinessHours(new Date('2026-06-01T13:30:00Z'))).toBe(true); // Mon, PDT
    expect(isBusinessHours(new Date('2026-01-05T13:30:00Z'))).toBe(false); // Mon, PST
  });

  it('pacificClock reads the Pacific wall clock (not UTC)', () => {
    expect(pacificClock(new Date('2026-06-01T17:00:00Z'))).toEqual({ weekday: 1, hour: 10 });
  });
});
