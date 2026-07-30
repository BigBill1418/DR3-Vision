// Operator queue window — CURRENT PACIFIC DAY ONLY (2026-07-28 directive + fix).
//
// The queue previously computed its lower bound as `new Date().setHours(0,0,0,0)`
// — SERVER-LOCAL midnight — with no upper bound at all. Two consequences, both
// live in production until this fix:
//
//   1. No upper bound → every future expected load sat on the operator's queue.
//   2. Server-local midnight is UTC in the deployed container (no TZ set), while
//      both sites are Pacific. Between 5 PM and midnight Pacific the UTC day has
//      already rolled, so the queue silently jumped to TOMORROW mid-shift.
//
// (2) is the one that matters and is the case pinned below: an evening-shift
// operator at 6 PM Pacific must still see TODAY's loads, not tomorrow's.
//
// These tests exercise the boundary helpers the page now uses, so they fail if
// anyone reintroduces a local-midnight or open-ended window.

import { describe, expect, it } from 'vitest';
import { pacificDayISO, pacificDayStartInstant, pacificDayStartInstantPlus } from '@/lib/time';

/** The window the queue page builds. */
function queueWindow(now: Date) {
  return { gte: pacificDayStartInstant(now), lt: pacificDayStartInstantPlus(1, now) };
}

const inWindow = (at: Date, w: { gte: Date; lt: Date }) => at >= w.gte && at < w.lt;

describe('operator queue window — Pacific day boundary', () => {
  it('THE REGRESSION CASE: at 6 PM Pacific the window is still TODAY, not tomorrow', () => {
    // 2026-07-28 18:00 PDT === 2026-07-29 01:00 UTC. The UTC calendar day has
    // already rolled over; the Pacific one has not.
    const now = new Date('2026-07-29T01:00:00Z');
    expect(now.toISOString().slice(0, 10)).toBe('2026-07-29'); // UTC says the 29th…
    expect(pacificDayISO(now)).toBe('2026-07-28'); // …Pacific says the 28th.

    const w = queueWindow(now);

    // A load at 2 PM Pacific on the 28th — squarely in the evening crew's day.
    expect(inWindow(new Date('2026-07-28T21:00:00Z'), w)).toBe(true);
    // A load at 9 AM Pacific on the 29th — tomorrow, must NOT appear.
    expect(inWindow(new Date('2026-07-29T16:00:00Z'), w)).toBe(false);
  });

  it('excludes future days (the window is bounded, not open-ended)', () => {
    const now = new Date('2026-07-28T19:00:00Z'); // noon PDT
    const w = queueWindow(now);
    for (const future of ['2026-07-29T18:00:00Z', '2026-07-31T18:00:00Z', '2026-08-07T18:00:00Z']) {
      expect(inWindow(new Date(future), w)).toBe(false);
    }
  });

  it('excludes prior days (no historical view on the iPad)', () => {
    const now = new Date('2026-07-28T19:00:00Z');
    const w = queueWindow(now);
    expect(inWindow(new Date('2026-07-27T19:00:00Z'), w)).toBe(false);
    expect(inWindow(new Date('2026-07-22T19:00:00Z'), w)).toBe(false);
  });

  it('includes the first and last instants of the Pacific day, exclusive at the end', () => {
    const now = new Date('2026-07-28T19:00:00Z');
    const w = queueWindow(now);
    expect(inWindow(w.gte, w)).toBe(true); // Pacific midnight itself
    expect(inWindow(new Date(w.lt.getTime() - 1), w)).toBe(true); // 23:59:59.999 PT
    expect(inWindow(w.lt, w)).toBe(false); // next Pacific midnight
  });

  it('window is exactly 24h in PDT and DST-correct across a fall-back day', () => {
    const pdt = queueWindow(new Date('2026-07-28T19:00:00Z'));
    expect(pdt.lt.getTime() - pdt.gte.getTime()).toBe(24 * 3_600_000);

    // 2026-11-01 is the US DST fall-back — that Pacific day is 25 hours long.
    const dst = queueWindow(new Date('2026-11-01T19:00:00Z'));
    expect(pacificDayISO(dst.gte)).toBe('2026-11-01');
    expect(dst.lt.getTime() - dst.gte.getTime()).toBe(25 * 3_600_000);
  });

  it('an early-morning Pacific instant resolves to that same Pacific day', () => {
    // 00:30 PDT on the 28th === 07:30 UTC on the 28th.
    const now = new Date('2026-07-28T07:30:00Z');
    expect(pacificDayISO(now)).toBe('2026-07-28');
    const w = queueWindow(now);
    expect(inWindow(new Date('2026-07-28T21:00:00Z'), w)).toBe(true);
    expect(inWindow(new Date('2026-07-27T21:00:00Z'), w)).toBe(false);
  });
});
