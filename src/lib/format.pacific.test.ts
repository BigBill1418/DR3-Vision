// ADR-0065 Amendment 1 — `formatTime` / `formatDate` must render Pacific.
//
// ── The defect these lock down ───────────────────────────────────────────────
// Both formatters omitted `timeZone`, so `Intl` fell back to the runtime default.
// Measured inside the production container `dr3-vision-app` on 2026-07-30:
//
//   Intl.DateTimeFormat().resolvedOptions().timeZone  ->  "UTC"
//
// Woodland's real docking appointment for 2026-07-30 is stored as
// `2026-07-30T17:00:00Z`, i.e. 10:00 AM PDT. The floor queue rendered it as
// "5:00 PM". The most common MyMRC slot, `15:00Z` (8:00 AM PDT), rendered as
// "3:00 PM". A 7-hour lie on the one field the dock queue exists to communicate.
//
// This suite forces UTC as the ambient zone (`vi.stubEnv('TZ', 'UTC')` cannot
// retroactively change an already-constructed Intl object, so instead we assert
// against the ABSOLUTE expected Pacific wall-clock — a formatter that fell back to
// any non-Pacific zone produces a different string and fails regardless of what
// zone the test host happens to run in).

import { describe, it, expect } from 'vitest';
import { formatTime, formatDate } from './format';

describe('formatTime — Pacific pinning', () => {
  it("renders Woodland's 2026-07-30 appointment as 10:00 AM, not 5:00 PM", () => {
    // The exact production row that was being mis-rendered.
    expect(formatTime(new Date('2026-07-30T17:00:00.000Z'), 'en')).toBe('10:00 AM');
  });

  it('renders the most common MyMRC slot (15:00Z) as 8:00 AM, not 3:00 PM', () => {
    expect(formatTime(new Date('2026-07-30T15:00:00.000Z'), 'en')).toBe('8:00 AM');
  });

  it('is DST-aware — the same UTC clock time shifts an hour across the seam', () => {
    // PDT (UTC-7) in July, PST (UTC-8) in January. A fixed -7 offset hack would
    // return 8:00 AM for both and fail the winter case.
    expect(formatTime(new Date('2026-07-15T15:00:00.000Z'), 'en')).toBe('8:00 AM');
    expect(formatTime(new Date('2026-01-15T15:00:00.000Z'), 'en')).toBe('7:00 AM');
  });

  it('crosses the UTC day boundary without rolling the Pacific clock forward', () => {
    // 2026-07-31T01:30:00Z is 6:30 PM PDT on 2026-07-30 — the evening-shift case
    // that motivated the whole current-Pacific-day floor. A UTC formatter shows
    // "1:30 AM"; the operator's clock says 6:30 PM.
    expect(formatTime(new Date('2026-07-31T01:30:00.000Z'), 'en')).toBe('6:30 PM');
  });
});

describe('formatDate — Pacific pinning', () => {
  it("keeps the evening-shift instant on the operator's calendar day", () => {
    // Same instant as above. In UTC it is Fri Jul 31; in Pacific it is Thu Jul 30.
    // Getting this wrong labels an unfinished load with tomorrow's date.
    expect(formatDate(new Date('2026-07-31T01:30:00.000Z'), 'en')).toBe('Thu, Jul 30');
  });

  it('does not shift a mid-morning instant', () => {
    expect(formatDate(new Date('2026-07-30T17:00:00.000Z'), 'en')).toBe('Thu, Jul 30');
  });
});

describe('formatTime — locale coverage', () => {
  it('formats the floor locales without falling back to a non-Pacific zone', () => {
    // es-MX renders 24-hour; the hour digits are what matter. A UTC formatter
    // would emit 17 here instead of 10.
    expect(formatTime(new Date('2026-07-30T17:00:00.000Z'), 'es')).toContain('10:00');
    expect(formatTime(new Date('2026-07-30T17:00:00.000Z'), 'es')).not.toContain('17:00');
    // ur-PK may render Urdu digits, so assert the negative: never the UTC hour in
    // Latin digits.
    expect(formatTime(new Date('2026-07-30T17:00:00.000Z'), 'ur')).not.toContain('17:00');
  });
});
