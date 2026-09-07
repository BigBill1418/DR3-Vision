// ADR-0130 D6 — the business-day clock the freshness guard measures in.
//
// The guard shipped measuring CALENDAR hours (`96h`), justified as "96h clears a
// normal weekend plus a holiday Monday without firing." Measured against the live
// mirror it does not: an ordinary Monday peaks at 83-99 h against a 96 h threshold,
// so whether Bill's phone rang on any given Monday was decided by what time on
// Saturday MyMRC happened to post Friday's row. Three false pages in thirty-eight
// days, all on a Monday or Tuesday.
//
// The MyMRC `processed` feed carries exactly ONE row per business day. A feed that
// only advances on business days cannot be measured in calendar hours.

import { describe, expect, it } from 'vitest';
import { businessDaysBetween, isBusinessDay, pacificDayISO } from './business-days';

/** The six closures Bill confirmed for both sites (prisma/seed/site_holidays.csv). */
const HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-05-25',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);
const NONE: ReadonlySet<string> = new Set<string>();

describe('pacificDayISO — the day key everything else is counted in', () => {
  it('reads the PACIFIC calendar day, not the UTC one', () => {
    // 2026-09-08 02:00 UTC is still 2026-09-07 19:00 in Pacific. Counting this as
    // the 8th would silently add a business day to every evening measurement.
    expect(pacificDayISO(new Date('2026-09-08T02:00:00Z'))).toBe('2026-09-07');
    expect(pacificDayISO(new Date('2026-09-07T18:00:00Z'))).toBe('2026-09-07');
    expect(pacificDayISO(new Date('2026-09-07T07:00:00Z'))).toBe('2026-09-07');
    // 06:59 UTC is 23:59 the PREVIOUS Pacific day (PDT, UTC-7).
    expect(pacificDayISO(new Date('2026-09-07T06:59:00Z'))).toBe('2026-09-06');
  });

  it('is DST-correct — the offset is 8 in winter, 7 in summer', () => {
    expect(pacificDayISO(new Date('2026-01-15T07:30:00Z'))).toBe('2026-01-14'); // PST, UTC-8
    expect(pacificDayISO(new Date('2026-07-15T07:30:00Z'))).toBe('2026-07-15'); // PDT, UTC-7
  });

  it('reads a noon-anchored mirror timestamp as its own day', () => {
    // Every MyMRC business date is stored NOON-anchored — verified on production
    // 2026-09-07: `mymrc_processed_mirror.entry_date` = `2026-09-03 12:00:00`, and
    // `max(COALESCE(recycler_reported_delivery_date, docking_appointment_date))` on
    // the hauls mirror = `2026-09-04 12:00:00`. That anchor is load-bearing here: it
    // is what makes the calendar day the same in UTC and in Pacific.
    expect(pacificDayISO(new Date('2026-09-03T12:00:00Z'))).toBe('2026-09-03');
    expect(pacificDayISO(new Date('2026-09-04T12:00:00Z'))).toBe('2026-09-04');
    // The counter-example the anchor protects against: a MIDNIGHT-UTC value is the
    // PREVIOUS Pacific day, which would overstate the deficit by one business day.
    expect(pacificDayISO(new Date('2026-09-04T00:00:00Z'))).toBe('2026-09-03');
  });
});

describe('isBusinessDay', () => {
  it('excludes Saturday and Sunday', () => {
    expect(isBusinessDay('2026-09-04', NONE)).toBe(true); // Fri
    expect(isBusinessDay('2026-09-05', NONE)).toBe(false); // Sat
    expect(isBusinessDay('2026-09-06', NONE)).toBe(false); // Sun
    expect(isBusinessDay('2026-09-08', NONE)).toBe(true); // Tue
  });

  it('excludes an observed holiday — 2026-09-07 is Labor Day', () => {
    expect(isBusinessDay('2026-09-07', NONE)).toBe(true); // a Monday, absent the list
    expect(isBusinessDay('2026-09-07', HOLIDAYS_2026)).toBe(false);
  });
});

describe('businessDaysBetween — how far behind the newest record is', () => {
  // The count is of business days D with `from < D <= to`: "how many working days
  // have gone by since the day we last heard about, up to and including today".
  it('is 0 on the same day and 0 for a future-dated record', () => {
    expect(businessDaysBetween('2026-09-03', '2026-09-03', NONE)).toBe(0);
    // The `hauls` feed is measured on a scheduling date that is normally FUTURE-
    // dated; it must never count as behind.
    expect(businessDaysBetween('2026-09-30', '2026-09-07', NONE)).toBe(0);
  });

  it('counts one for each intervening weekday', () => {
    expect(businessDaysBetween('2026-09-01', '2026-09-02', NONE)).toBe(1); // Tue->Wed
    expect(businessDaysBetween('2026-09-01', '2026-09-04', NONE)).toBe(3); // Tue->Fri
  });

  it('does not count a weekend — Thursday to Monday is 2, not 4', () => {
    expect(businessDaysBetween('2026-09-03', '2026-09-07', NONE)).toBe(2);
  });

  it('does not count Labor Day — the 2026-09-07 false page', () => {
    // THE case. Newest processed record is Thu 2026-09-03; "today" is Mon
    // 2026-09-07. Calendar age is 105 h, so the 96 h rule FIRED. In business days
    // it is Friday only — Labor Day is a closure — so it is 1, and 1 is not > 2.
    expect(businessDaysBetween('2026-09-03', '2026-09-07', HOLIDAYS_2026)).toBe(1);
  });

  it('reproduces the ADR-0130 §3 table exactly', () => {
    // Every row of the measured age curve, business-days column. The three FALSE
    // 96 h fires all sit at <= 2; the real nine-day freeze sits at 9.
    const cases: Array<[string, string, number]> = [
      ['2026-07-20', '2026-07-31', 9], // Fri 07-31 — the REAL outage
      ['2026-07-31', '2026-08-04', 2], // Tue 08-04 — 96h fired, falsely
      ['2026-08-13', '2026-08-17', 2], // Mon 08-17 — 96h fired, falsely
      ['2026-08-28', '2026-08-31', 1], // Mon 08-31
      ['2026-09-03', '2026-09-07', 1], // Mon 09-07 — 96h fired, falsely
    ];
    for (const [newest, today, expected] of cases) {
      expect(businessDaysBetween(newest, today, HOLIDAYS_2026)).toBe(expected);
    }
  });

  it('is FASTER than 96h on a real freeze (the ADR-0130 D6 claim)', () => {
    // A Wednesday freeze: the last record is Wed 2026-09-16. By Friday 09-18 the
    // deficit is 2; by Monday 09-21 it is 3 and the rule fires. The 96 h rule
    // needs a fourth calendar day AND is subject to the same posting jitter that
    // made ordinary Mondays fire.
    expect(businessDaysBetween('2026-09-16', '2026-09-18', HOLIDAYS_2026)).toBe(2);
    expect(businessDaysBetween('2026-09-16', '2026-09-21', HOLIDAYS_2026)).toBe(3);
  });

  it('caps a pathological range instead of spinning', () => {
    // A corrupt entry_date far in the past must not walk ten years of days on the
    // hourly cron. Same guard `ap/business-clock.ts` puts on `businessHoursBetween`.
    expect(businessDaysBetween('1970-01-01', '2026-09-07', NONE)).toBeLessThanOrEqual(400);
  });
});
