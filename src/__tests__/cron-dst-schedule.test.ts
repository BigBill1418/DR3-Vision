// DST-transition regression for the offset-reprobe port (stack-sweep 2026-07-10).
//
// Seven daemon schedulers shared a naive "delta seconds-of-day added to `from`"
// next-fire computation that assumed every Pacific day is 86400s. That double-fired
// on fall-back (the 25h day — it landed 1h early, then re-fired at the real time)
// and fired 1h late on spring-forward (the 23h day). survey-reminder is covered in
// its own test; this file pins the remaining ported daemons. Each exports the same
// offset-reprobe `nextFireInstantAt(from, hour, minute)` (or, for the weekly fuel
// daemon, `nextWeeklyFireInstant`), so we exercise each file's own copy.
//
// The two transition days: fall-back 2026-11-01 (02:00 PDT → 01:00 PST) and
// spring-forward 2027-03-14 (02:00 PST → 03:00 PDT). We probe with a neutral 09:00
// fire (clear of the 02:00 transition, so no non-existent / ambiguous wall time)
// except bonus-eod-check, whose fire time is fixed at 20:00 PT (the 8pm entry
// deadline, ADR-0019 §2 amendment 2026-07-21).

import { describe, it, expect } from 'vitest';

import { nextFireInstantAt as auditNextFire } from '../../scripts/audit-sweep-cron.mjs';
import { nextFireInstantAt as apExpiryNextFire } from '../../scripts/ap-approver-expiry-cron.mjs';
import { nextFireInstantAt as apBaselineNextFire } from '../../scripts/ap-baseline-rebuild-cron.mjs';
import { nextFireInstantAt as apMorningDigestNextFire } from '../../scripts/ap-morning-digest.mjs';
import { nextFireInstantAt as boardPackNextFire } from '../../scripts/board-pack-digest-cron.mjs';
import { nextFireInstantAt as dailyReportNextFire } from '../../scripts/bonus-daily-report.mjs';
import { nextFireInstant as eodNextFire } from '../../scripts/bonus-eod-check.mjs';
import { nextWeeklyFireInstant as fuelNextWeeklyFire } from '../../scripts/fuel-price-cron.mjs';
// ADR-0092 — the stale-claim watchdog (16:45 PT), and the throughput-gap watchdog
// (08:30 PT) it was copied from. The latter shipped under ADR-0088 carrying its
// own copy of the offset-reprobe helper and was never added here; both are pinned
// now, because an untested copy of this function is exactly how the original
// seven-daemon defect happened.
import { nextFireInstantAt as throughputGapNextFire } from '../../scripts/equipment-throughput-gap-cron.mjs';
import { nextFireInstantAt as staleClaimNextFire } from '../../scripts/stale-claim-cron.mjs';
// ADR-0019.4 — the signature-chain health check (06:30 PT). Pinned from the day
// it ships rather than after a DST miss: this daemon exists to be trustworthy at
// 06:30 on a payroll morning, and an hour of drift would land it AFTER the 07:10
// escalation tier it is supposed to precede.
import { nextFireInstantAt as chainHealthNextFire } from '../../scripts/bonus-chain-health-cron.mjs';

/** The Pacific wall-clock "HH:MM" an absolute UTC instant lands on. */
function pacificHHMM(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** The Pacific weekday short-name ("Sun".."Sat") for a UTC instant. */
function pacificWeekday(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
  }).format(at);
}

// Every daily daemon shares the identical exported offset-reprobe function; assert
// each file's copy is correct across both transition days at a neutral 09:00 fire.
const DAILY: ReadonlyArray<[string, (from: Date, h: number, m: number) => Date]> = [
  ['audit-sweep-cron', auditNextFire as never],
  ['ap-approver-expiry-cron', apExpiryNextFire as never],
  ['ap-baseline-rebuild-cron', apBaselineNextFire as never],
  // ADR-0066 §1.7 — 06:00 PT is 13:00 UTC under PDT and 14:00 UTC under PST, so a
  // naive UTC cron would drift an hour twice a year. Pinned here like the rest.
  ['ap-morning-digest', apMorningDigestNextFire as never],
  ['board-pack-digest-cron', boardPackNextFire as never],
  ['bonus-daily-report', dailyReportNextFire as never],
  ['equipment-throughput-gap-cron', throughputGapNextFire as never],
  ['stale-claim-cron', staleClaimNextFire as never],
  ['bonus-chain-health-cron', chainHealthNextFire as never],
];

describe.each(DAILY)('%s — DST transition days', (_name, nextFire) => {
  it('fires exactly ONCE at 09:00 PT on fall-back day (2026-11-01), then rolls to the next day', () => {
    const from = new Date('2026-11-01T07:30:00Z'); // Nov 1 00:30 PDT (before the fall-back)
    const fire1 = nextFire(from, 9, 0);
    expect(pacificHHMM(fire1)).toBe('09:00');
    expect(fire1.toISOString()).toBe('2026-11-01T17:00:00.000Z'); // 09:00 PST (-8)
    const fire2 = nextFire(fire1, 9, 0);
    expect(pacificHHMM(fire2)).toBe('09:00');
    expect(fire2.toISOString()).toBe('2026-11-02T17:00:00.000Z'); // next day, not a re-fire
  });

  it('fires at 09:00 PT (not 10:00) on spring-forward day (2027-03-14)', () => {
    const from = new Date('2027-03-14T08:30:00Z'); // Mar 14 00:30 PST (before the spring-forward)
    const fire = nextFire(from, 9, 0);
    expect(pacificHHMM(fire)).toBe('09:00');
    expect(fire.toISOString()).toBe('2027-03-14T16:00:00.000Z'); // 09:00 PDT (-7)
  });
});

describe('ap-morning-digest — the actual 06:00 PT fire across DST (ADR-0066 §1.7)', () => {
  // The matrix above probes a neutral 09:00. This pins the REAL fire time, and
  // pins it as an absolute UTC instant, because the whole point is that a fixed
  // UTC cron entry cannot express it: 06:00 PT is 13:00 UTC in summer and 14:00
  // UTC in winter. Either literal is wrong for half the year.
  it('is 13:00 UTC under PDT and 14:00 UTC under PST', () => {
    const summer = apMorningDigestNextFire(new Date('2026-07-29T00:00:00Z'), 6, 0);
    expect(pacificHHMM(summer)).toBe('06:00');
    expect(summer.toISOString()).toBe('2026-07-29T13:00:00.000Z'); // PDT (-7)

    const winter = apMorningDigestNextFire(new Date('2026-12-09T00:00:00Z'), 6, 0);
    expect(pacificHHMM(winter)).toBe('06:00');
    expect(winter.toISOString()).toBe('2026-12-09T14:00:00.000Z'); // PST (-8)
  });

  it('fires once per day across the fall-back seam, still at 06:00 PT', () => {
    // Fall-back is 2026-11-01 at 02:00 PDT → 01:00 PST, so 06:00 PT on Nov 1 is
    // ALREADY PST. Consecutive fires shift by 25h of wall time here — which is
    // exactly what a fixed UTC cron gets wrong.
    const before = apMorningDigestNextFire(new Date('2026-10-30T20:00:00Z'), 6, 0);
    expect(before.toISOString()).toBe('2026-10-31T13:00:00.000Z'); // Oct 31 06:00 PDT
    const after = apMorningDigestNextFire(before, 6, 0);
    expect(pacificHHMM(after)).toBe('06:00');
    expect(after.toISOString()).toBe('2026-11-01T14:00:00.000Z'); // Nov 1 06:00 PST
  });
});

describe('bonus-eod-check — DST transition days (fixed 20:00 PT deadline)', () => {
  it('fires exactly ONCE at 20:00 PT on fall-back day (2026-11-01), then rolls to the next day', () => {
    const from = new Date('2026-11-01T07:30:00Z'); // Nov 1 00:30 PDT
    const fire1 = eodNextFire(from);
    expect(pacificHHMM(fire1)).toBe('20:00');
    expect(fire1.toISOString()).toBe('2026-11-02T04:00:00.000Z'); // Nov 1 20:00 PST (-8)
    const fire2 = eodNextFire(fire1);
    expect(pacificHHMM(fire2)).toBe('20:00');
    expect(fire2.toISOString()).toBe('2026-11-03T04:00:00.000Z');
  });

  it('fires at 20:00 PT on spring-forward day (2027-03-14)', () => {
    const from = new Date('2027-03-14T08:30:00Z'); // Mar 14 00:30 PST
    const fire = eodNextFire(from);
    expect(pacificHHMM(fire)).toBe('20:00');
    expect(fire.toISOString()).toBe('2027-03-15T03:00:00.000Z'); // Mar 14 20:00 PDT (-7)
  });
});

describe('fuel-price-cron — weekly Tue 06:00 PT across DST', () => {
  it('lands on Tuesday 06:00 PT for a week spanning the spring-forward (2027-03-14)', () => {
    // from = Fri 2027-03-12 evening PST; the next Tue 06:00 is 2027-03-16, so the
    // interval crosses the 2027-03-14 spring-forward. The naive weekly computation
    // (dayDelta*86400) would land 1h off.
    const from = new Date('2027-03-13T00:00:00Z'); // Fri Mar 12 16:00 PST
    const fire = fuelNextWeeklyFire(from, 2, 6, 0); // 2 = Tuesday
    expect(pacificWeekday(fire)).toBe('Tue');
    expect(pacificHHMM(fire)).toBe('06:00');
    expect(fire.toISOString()).toBe('2027-03-16T13:00:00.000Z'); // 06:00 PDT (-7)
    expect(fire.getTime()).toBeGreaterThan(from.getTime());
  });

  it('lands on Tuesday 06:00 PT for a week spanning the fall-back (2026-11-01)', () => {
    // from = Fri 2026-10-30 (PDT); next Tue = 2026-11-03, interval crosses the
    // 2026-11-01 fall-back.
    const from = new Date('2026-10-30T12:00:00Z'); // Fri Oct 30 05:00 PDT
    const fire = fuelNextWeeklyFire(from, 2, 6, 0);
    expect(pacificWeekday(fire)).toBe('Tue');
    expect(pacificHHMM(fire)).toBe('06:00');
    expect(fire.toISOString()).toBe('2026-11-03T14:00:00.000Z'); // 06:00 PST (-8)
    expect(fire.getTime()).toBeGreaterThan(from.getTime());
  });
});
