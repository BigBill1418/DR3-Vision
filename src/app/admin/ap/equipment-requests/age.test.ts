// ADR-0046 Amendment 9 (§2.5) — the aging column must count PACIFIC days.
//
// The container clock is UTC, 7–8h ahead of the people reading this queue. Every
// case below is chosen so a naive elapsed-time or UTC-calendar implementation
// gives a DIFFERENT answer than the correct Pacific-calendar one.

import { describe, it, expect } from 'vitest';
import { pacificAgeDays, pacificAgeLabel } from './age';

describe('pacificAgeDays — Pacific calendar days, not UTC and not elapsed/24', () => {
  it('a request filed this afternoon Pacific is 0 days old even though UTC says tomorrow', () => {
    // 2026-07-28 17:00 PDT === 2026-07-29 00:00Z. UTC calendar: 29th. Pacific: 28th.
    const filed = new Date('2026-07-29T00:00:00Z');
    const now = new Date('2026-07-29T02:00:00Z'); // 2026-07-28 19:00 PDT
    expect(pacificAgeDays(filed, now)).toBe(0);
    expect(pacificAgeLabel(filed, now)).toBe('today');
  });

  it('crossing Pacific midnight is 1 day, even though only 2 hours elapsed', () => {
    const filed = new Date('2026-07-29T06:00:00Z'); // 2026-07-28 23:00 PDT
    const now = new Date('2026-07-29T08:00:00Z'); // 2026-07-29 01:00 PDT
    expect(pacificAgeDays(filed, now)).toBe(1);
    expect(pacificAgeLabel(filed, now)).toBe('1 day');
  });

  it('23 hours that do NOT cross Pacific midnight is still 0 days', () => {
    const filed = new Date('2026-07-29T08:00:00Z'); // 2026-07-29 01:00 PDT
    const now = new Date('2026-07-30T06:59:00Z'); // 2026-07-29 23:59 PDT
    expect(pacificAgeDays(filed, now)).toBe(0);
  });

  it('counts whole Pacific days across a DST boundary (PDT → PST, 25-hour day)', () => {
    // US DST ends 2026-11-01. The 1st is a 25-hour Pacific day; an hour-arithmetic
    // implementation drifts here, a calendar-day one does not.
    const filed = new Date('2026-10-31T18:00:00Z'); // 2026-10-31 11:00 PDT
    const now = new Date('2026-11-03T19:00:00Z'); // 2026-11-03 11:00 PST
    expect(pacificAgeDays(filed, now)).toBe(3);
    expect(pacificAgeLabel(filed, now)).toBe('3 days');
  });

  it('never reports a negative age when the clock skews the request into the future', () => {
    const filed = new Date('2026-07-30T18:00:00Z');
    const now = new Date('2026-07-29T18:00:00Z');
    expect(pacificAgeDays(filed, now)).toBe(0);
    expect(pacificAgeLabel(filed, now)).toBe('today');
  });
});
