// ADR-0049 Am.4 B1 — grace-window policy tests.
//
// Every guard here was FALSIFIED before being kept: the implementation was broken
// on purpose, the test was observed to go red, and only then was the code restored.
// A guard that has never been seen to fail is a guard nobody has tested.

import { describe, expect, it } from 'vitest';
import {
  GRACE_BUSINESS_DAYS,
  billedDaysFor,
  isGraceWindowOpen,
  nthBusinessDayOfMonth,
  priorMonthAnchor,
} from './grace';
import { resolveMonthlyFileName } from './naming';
import { FakePrisma } from './__tests__/fake-prisma';

const PATTERN = '{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm';

describe('nthBusinessDayOfMonth', () => {
  it('skips the weekend that opens August 2026 (1st = Sat)', () => {
    // Aug 1 Sat, 2 Sun, 3 Mon(1), 4(2), 5(3), 6(4), 7 Fri(5).
    expect(nthBusinessDayOfMonth(2026, 7, 1)).toBe(3);
    expect(nthBusinessDayOfMonth(2026, 7, 5)).toBe(7);
  });

  it('counts a month that opens mid-week (January 2026, 1st = Thu)', () => {
    // Jan 1 Thu(1), 2 Fri(2), 3 Sat, 4 Sun, 5 Mon(3), 6(4), 7 Wed(5).
    expect(nthBusinessDayOfMonth(2026, 0, 5)).toBe(7);
  });

  it('does not run off the end of a short month', () => {
    // February 2026 has 28 days; the 20th business day must still be inside it.
    expect(nthBusinessDayOfMonth(2026, 1, 20)).toBeLessThanOrEqual(28);
  });
});

describe('isGraceWindowOpen', () => {
  // 20:00 UTC is midday Pacific in both offsets — these instants are unambiguous.
  const at = (iso: string): Date => new Date(`${iso}T20:00:00.000Z`);

  it('is open across the opening weekend and through the 5th business day', () => {
    expect(isGraceWindowOpen(at('2026-08-01'))).toBe(true); // Sat
    expect(isGraceWindowOpen(at('2026-08-03'))).toBe(true); // Mon
    expect(isGraceWindowOpen(at('2026-08-07'))).toBe(true); // Fri — last day
  });

  it('is CLOSED on the day after the window, so July can never be rewritten later', () => {
    expect(isGraceWindowOpen(at('2026-08-08'))).toBe(false);
    expect(isGraceWindowOpen(at('2026-08-20'))).toBe(false);
  });

  it('reads the PACIFIC day, not the UTC day', () => {
    // 2026-08-01T03:00Z is 31 July, 8pm PDT. Pacific is still in July, so the
    // "prior month" is June and the window question is about July's own 1st-5th —
    // long closed. Reading this instant as 1 August would open a window that
    // re-polls JUNE on the last evening of July.
    expect(isGraceWindowOpen(new Date('2026-08-01T03:00:00.000Z'))).toBe(false);
  });

  it('defaults to five business days', () => {
    expect(GRACE_BUSINESS_DAYS).toBe(5);
  });
});

describe('priorMonthAnchor', () => {
  it('resolves the prior month FILE NAME, which is what the sync actually fetches', () => {
    const anchor = priorMonthAnchor(new Date('2026-08-03T20:00:00.000Z'));
    expect(resolveMonthlyFileName(PATTERN, anchor)).toBe('JULY 2026 DAILY LOG WOODLAND.xlsm');
  });

  it('crosses the year boundary', () => {
    const anchor = priorMonthAnchor(new Date('2026-01-05T20:00:00.000Z'));
    expect(resolveMonthlyFileName(PATTERN, anchor)).toBe('DECEMBER 2025 DAILY LOG WOODLAND.xlsm');
  });

  it('is unaffected by the DST transition month', () => {
    // March 2026 contains the spring-forward. An anchor built by subtracting a
    // fixed number of days lands on the wrong side of it; the 15th-at-midday
    // anchor cannot.
    const anchor = priorMonthAnchor(new Date('2026-03-06T20:00:00.000Z'));
    expect(resolveMonthlyFileName(PATTERN, anchor)).toBe('FEBRUARY 2026 DAILY LOG WOODLAND.xlsm');
  });

  it('lands inside the prior month for EVERY in-window day of EVERY month', () => {
    // Days 1–8 cover every day the grace window can be open in any month, and the
    // 1st is the case that separates a real month-arithmetic anchor from the
    // plausible-looking `now - 30 days`: on 1 March that subtraction lands on 30
    // January, so the sync would re-poll JANUARY while claiming to catch up
    // February. February is short; 30 days is not a month.
    for (let m = 0; m < 12; m += 1) {
      for (let day = 1; day <= 8; day += 1) {
        const now = new Date(Date.UTC(2026, m, day, 20, 0, 0));
        const anchor = priorMonthAnchor(now);
        const expectedMonth = (m + 11) % 12;
        const expectedYear = m === 0 ? 2025 : 2026;
        expect(
          { m: anchor.getUTCMonth(), y: anchor.getUTCFullYear() },
          `anchor for 2026-${m + 1}-${day}`,
        ).toEqual({ m: expectedMonth, y: expectedYear });
      }
    }
  });
});

describe('billedDaysFor', () => {
  const DAYS = ['2026-07-28', '2026-07-29', '2026-07-30'];

  function db(): FakePrisma {
    return new FakePrisma();
  }

  it('returns nothing when no invoice exists', async () => {
    expect((await billedDaysFor(db().asClient(), 'site-woodland', DAYS)).size).toBe(0);
  });

  it('flags days an APPROVED invoice covers', async () => {
    const p = db();
    p.invoices.push({
      site_id: 'site-woodland',
      status: 'approved',
      voided_at: null,
      window_start: new Date('2026-07-01T00:00:00.000Z'),
      window_end: new Date('2026-07-29T00:00:00.000Z'),
    });
    const billed = await billedDaysFor(p.asClient(), 'site-woodland', DAYS);
    expect([...billed].sort()).toEqual(['2026-07-28', '2026-07-29']);
    // The boundary is INCLUSIVE — an off-by-one here rewrites the last billed day.
    expect(billed.has('2026-07-29')).toBe(true);
    expect(billed.has('2026-07-30')).toBe(false);
  });

  it('ignores DRAFT invoices — a draft has been shown to nobody', async () => {
    const p = db();
    p.invoices.push({
      site_id: 'site-woodland',
      status: 'draft',
      voided_at: null,
      window_start: new Date('2026-07-01T00:00:00.000Z'),
      window_end: new Date('2026-07-31T00:00:00.000Z'),
    });
    expect((await billedDaysFor(p.asClient(), 'site-woodland', DAYS)).size).toBe(0);
  });

  it('ignores VOIDED invoices — a void says the invoice no longer stands', async () => {
    const p = db();
    p.invoices.push({
      site_id: 'site-woodland',
      status: 'approved',
      voided_at: new Date('2026-08-02T00:00:00.000Z'),
      window_start: new Date('2026-07-01T00:00:00.000Z'),
      window_end: new Date('2026-07-31T00:00:00.000Z'),
    });
    expect((await billedDaysFor(p.asClient(), 'site-woodland', DAYS)).size).toBe(0);
  });

  it('does not leak another site’s invoice', async () => {
    const p = db();
    p.invoices.push({
      site_id: 'site-eugene',
      status: 'approved',
      voided_at: null,
      window_start: new Date('2026-07-01T00:00:00.000Z'),
      window_end: new Date('2026-07-31T00:00:00.000Z'),
    });
    expect((await billedDaysFor(p.asClient(), 'site-woodland', DAYS)).size).toBe(0);
  });

  it('is a no-op on an empty day list (no query, no crash)', async () => {
    expect((await billedDaysFor(db().asClient(), 'site-woodland', [])).size).toBe(0);
  });
});
