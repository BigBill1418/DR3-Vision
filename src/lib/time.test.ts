// TZ source-of-truth tests (@/lib/time) — the Pacific business-day fix.
//
// The canonical regression: a late-evening Pacific instant is already past UTC
// midnight, so a UTC-derived "today" is off by one. These tests pin a fixed
// instant and assert the Pacific calendar day — they FAIL under the old UTC
// logic and PASS under the Pacific logic. The clock is injected (every helper
// takes an `instant` arg), so the result never depends on the runner's TZ.

import { describe, it, expect } from 'vitest';
import {
  appToday,
  appTodayISO,
  appCurrentMonthStart,
  appCurrentYear,
  pacificDayISO,
  pacificDayKeyUTC,
  dayKeyUTCFromISO,
  dayISO,
  pacificDateLabel,
  pacificMonthLabel,
  formatPacificDateTime,
  isPacificWeekend,
  pacificDayStartInstant,
  pacificDayStartInstantPlus,
} from '@/lib/time';

// THE bug instant: 10:50 PM PDT on 2026-06-05 == 2026-06-06T05:50:00Z.
// UTC says June 6; Pacific (and the facilities) say June 5.
const LATE_EVENING_PACIFIC = new Date('2026-06-06T05:50:00Z');

describe('appToday / Pacific business day (the TZ bug)', () => {
  it('late-evening Pacific resolves to the Pacific calendar day, NOT the UTC day', () => {
    // This is the exact symptom Bill hit ("loading entries for 6/6/26").
    expect(pacificDayISO(LATE_EVENING_PACIFIC)).toBe('2026-06-05');
    expect(appTodayISO(LATE_EVENING_PACIFIC)).toBe('2026-06-05');
    // A naive UTC read would have produced 2026-06-06 — assert we did NOT.
    expect(pacificDayISO(LATE_EVENING_PACIFIC)).not.toBe('2026-06-06');
  });

  it('appToday is the UTC-midnight @db.Date key of the Pacific day', () => {
    const key = appToday(LATE_EVENING_PACIFIC);
    expect(key.toISOString()).toBe('2026-06-05T00:00:00.000Z');
    // UTC components are the Pacific calendar Y/M/D (the storage invariant).
    expect(key.getUTCFullYear()).toBe(2026);
    expect(key.getUTCMonth()).toBe(5); // June (0-based)
    expect(key.getUTCDate()).toBe(5);
  });

  it('pacificDayKeyUTC equals appToday for the same instant', () => {
    expect(pacificDayKeyUTC(LATE_EVENING_PACIFIC).getTime()).toBe(
      appToday(LATE_EVENING_PACIFIC).getTime(),
    );
  });

  it('mid-afternoon Pacific (well before the seam) is unambiguous', () => {
    // 2:00 PM PDT 2026-06-05 == 21:00Z same day; both zones agree.
    expect(appTodayISO(new Date('2026-06-05T21:00:00Z'))).toBe('2026-06-05');
  });

  it('handles a PST (winter, UTC-8) late evening too', () => {
    // 11:30 PM PST 2026-01-15 == 2026-01-16T07:30:00Z. Pacific day is the 15th.
    expect(appTodayISO(new Date('2026-01-16T07:30:00Z'))).toBe('2026-01-15');
  });
});

describe('month / year anchored on Pacific', () => {
  it('current month start uses the Pacific day, not UTC', () => {
    // 11:40 PM PDT 2026-06-30 == 2026-07-01T06:40:00Z. UTC says July; Pacific June.
    const endOfJunePacific = new Date('2026-07-01T06:40:00Z');
    expect(appCurrentMonthStart(endOfJunePacific).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('current year uses the Pacific day across the New Year seam', () => {
    // 9:00 PM PST 2026-12-31 == 2027-01-01T05:00:00Z. Pacific year is still 2026.
    expect(appCurrentYear(new Date('2027-01-01T05:00:00Z'))).toBe(2026);
  });
});

describe('dayKeyUTCFromISO / dayISO round-trip', () => {
  it('builds UTC midnight from a calendar string', () => {
    expect(dayKeyUTCFromISO('2026-06-05').toISOString()).toBe('2026-06-05T00:00:00.000Z');
  });
  it('rejects a malformed day', () => {
    expect(() => dayKeyUTCFromISO('2026/06/05')).toThrow();
    expect(() => dayKeyUTCFromISO('not-a-date')).toThrow();
  });
  it('dayISO renders a @db.Date key back to YYYY-MM-DD', () => {
    expect(dayISO(new Date('2026-06-05T00:00:00.000Z'))).toBe('2026-06-05');
  });
});

describe('display helpers respect the storage invariant', () => {
  it('pacificDateLabel renders a @db.Date day in UTC (no re-shift)', () => {
    // The stored key for June 5 must read "June 5", never "June 4".
    const key = dayKeyUTCFromISO('2026-06-05');
    expect(pacificDateLabel(key, 'en')).toContain('June 5');
    expect(pacificDateLabel(key, 'en')).toContain('2026');
  });
  it('pacificMonthLabel renders the stored month', () => {
    expect(pacificMonthLabel(dayKeyUTCFromISO('2026-06-01'), 'en')).toBe('June 2026');
  });
  it('formatPacificDateTime renders a true instant in Pacific wall clock', () => {
    // 05:50Z is 10:50 PM the previous Pacific day — the label must show the 5th.
    const label = formatPacificDateTime(LATE_EVENING_PACIFIC, 'en');
    expect(label).toContain('Jun 5');
  });
});

describe('weekend + instant boundaries', () => {
  it('isPacificWeekend reads the Pacific day', () => {
    // 2026-06-06 is a Saturday; 03:00Z on the 6th is still Friday the 5th in PT.
    expect(isPacificWeekend(new Date('2026-06-06T03:00:00Z'))).toBe(false); // Fri PT
    expect(isPacificWeekend(new Date('2026-06-06T18:00:00Z'))).toBe(true); // Sat PT
  });

  it('pacificDayStartInstant is the UTC instant of Pacific midnight (PDT, UTC-7)', () => {
    // Pacific midnight of 2026-06-05 == 2026-06-05T07:00:00Z in summer.
    const start = pacificDayStartInstant(new Date('2026-06-05T21:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-05T07:00:00.000Z');
  });

  it('pacificDayStartInstant is DST-correct in winter (PST, UTC-8)', () => {
    // Pacific midnight of 2026-01-15 == 2026-01-15T08:00:00Z.
    const start = pacificDayStartInstant(new Date('2026-01-15T20:00:00Z'));
    expect(start.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('pacificDayStartInstantPlus(1) advances one Pacific day', () => {
    const next = pacificDayStartInstantPlus(1, new Date('2026-06-05T21:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-06T07:00:00.000Z');
  });

  // REGRESSION (2026-07-28): the old `base + days*86_400_000` + re-snap
  // implementation returned the BASE INSTANT on the DST fall-back day — a
  // 25-hour Pacific day, where +24h is still inside the same day. That made
  // `pacificDayStartInstantPlus(1)` a ZERO-WIDTH window, which would have
  // silently emptied the invoice generation window
  // (`lib/invoices/generation-inputs.ts`), the manager loads date filters, and
  // the operator queue on 2026-11-01.
  it('spans a full 25h across the DST fall-back day (was 0h)', () => {
    const noon = new Date('2026-11-01T19:00:00Z');
    const start = pacificDayStartInstant(noon);
    const next = pacificDayStartInstantPlus(1, noon);
    expect(next.getTime() - start.getTime()).toBe(25 * 3_600_000);
    expect(next.getTime()).toBeGreaterThan(start.getTime());
  });

  it('spans 23h across the DST spring-forward day', () => {
    const noon = new Date('2026-03-08T19:00:00Z');
    const start = pacificDayStartInstant(noon);
    const next = pacificDayStartInstantPlus(1, noon);
    expect(next.getTime() - start.getTime()).toBe(23 * 3_600_000);
  });

  it('steps backwards correctly across the fall-back boundary', () => {
    const to = pacificDayStartInstantPlus(1, new Date('2026-11-04T19:00:00Z'));
    expect(pacificDayISO(pacificDayStartInstantPlus(-7, to))).toBe('2026-10-29');
  });

  it('always lands on Pacific midnight for any offset', () => {
    const base = new Date('2026-10-30T19:00:00Z');
    for (const d of [-30, -7, -1, 0, 1, 7, 30]) {
      const at = pacificDayStartInstantPlus(d, base);
      expect(at.getTime()).toBe(pacificDayStartInstant(at).getTime());
    }
  });
});
