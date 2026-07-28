// ADR-0065 — the floor iPad's "today" must be the PACIFIC day, not the server's.
//
// This is the test that matters most, because it is the exact case the previous
// queue code got wrong. The app container runs UTC (`docker exec dr3-vision-app
// date` → UTC, no TZ set), so `new Date(); d.setHours(0,0,0,0)` produced UTC
// midnight. From 5:00 PM Pacific onward, UTC has already rolled to the next
// calendar day — so an evening-shift operator's queue would silently switch to
// TOMORROW mid-shift, hiding the loads they were actually working.

import { describe, it, expect } from 'vitest';
import { currentPacificDayWindow, pacificDayISO } from './time';

/** 6:00 PM Pacific on 2026-07-28 (PDT, UTC-7) = 2026-07-29T01:00:00Z. */
const SIX_PM_PACIFIC = new Date('2026-07-29T01:00:00Z');

describe('currentPacificDayWindow', () => {
  it('resolves to the PACIFIC day at 6 PM Pacific, when UTC has already rolled over', () => {
    // Sanity: UTC really is on the next day at this instant — the trap.
    expect(SIX_PM_PACIFIC.toISOString().slice(0, 10)).toBe('2026-07-29');
    expect(pacificDayISO(SIX_PM_PACIFIC)).toBe('2026-07-28');

    const { start, endExclusive } = currentPacificDayWindow(SIX_PM_PACIFIC);
    // Pacific midnight 2026-07-28 (PDT, UTC-7) = 07:00Z the same date.
    expect(start.toISOString()).toBe('2026-07-28T07:00:00.000Z');
    expect(endExclusive.toISOString()).toBe('2026-07-29T07:00:00.000Z');
  });

  it('EXCLUDES tomorrow at 6 PM Pacific (the defect: unbounded gte showed 14 future loads)', () => {
    const { start, endExclusive } = currentPacificDayWindow(SIX_PM_PACIFIC);
    const inWindow = (d: Date) => d >= start && d < endExclusive;

    // Today's load, mid-afternoon Pacific.
    expect(inWindow(new Date('2026-07-28T21:00:00Z'))).toBe(true);
    // The operator's own current instant.
    expect(inWindow(SIX_PM_PACIFIC)).toBe(true);
    // Tomorrow's loads (2026-07-29 Pacific) — the rows Bill does not want shown.
    expect(inWindow(new Date('2026-07-29T17:00:00Z'))).toBe(false);
    // Yesterday — no historical view either.
    expect(inWindow(new Date('2026-07-27T20:00:00Z'))).toBe(false);
  });

  it('is a half-open window: the exact end instant belongs to TOMORROW', () => {
    const { endExclusive } = currentPacificDayWindow(SIX_PM_PACIFIC);
    expect(endExclusive >= endExclusive).toBe(true);
    // A load at exactly Pacific midnight is the next day's first load, not today's.
    expect(endExclusive < endExclusive).toBe(false);
    expect(pacificDayISO(endExclusive)).toBe('2026-07-29');
  });

  it('is stable just BEFORE the Pacific rollover (11:59 PM Pacific)', () => {
    const justBefore = new Date('2026-07-29T06:59:00Z'); // 23:59 PDT on 07-28
    expect(pacificDayISO(justBefore)).toBe('2026-07-28');
    expect(currentPacificDayWindow(justBefore).start.toISOString()).toBe(
      '2026-07-28T07:00:00.000Z',
    );
  });

  it('rolls at Pacific midnight, not UTC midnight', () => {
    // 00:30 Pacific on 07-29 = 07:30Z. UTC rolled 7.5h earlier; Pacific just now.
    const justAfter = new Date('2026-07-29T07:30:00Z');
    expect(currentPacificDayWindow(justAfter).start.toISOString()).toBe('2026-07-29T07:00:00.000Z');
  });

  it('handles PST (winter, UTC-8) as well as PDT', () => {
    const winterEvening = new Date('2026-01-15T02:00:00Z'); // 6 PM PST on 01-14
    expect(pacificDayISO(winterEvening)).toBe('2026-01-14');
    const { start, endExclusive } = currentPacificDayWindow(winterEvening);
    expect(start.toISOString()).toBe('2026-01-14T08:00:00.000Z');
    expect(endExclusive.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });
});
