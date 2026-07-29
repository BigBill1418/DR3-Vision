// ADR-0066 §1.5 — the AP escalation-scan daemon's two pure surfaces.
//
// SCHEDULE: unlike every sibling daemon this fires HOURLY, not at a Pacific wall
// clock time, so it deliberately carries no offset-reprobe logic — an hour is an
// hour in every zone. These tests pin that: the cadence must stay exactly one
// hour across both DST transition days, which is precisely the property the
// wall-clock daemons had to work for and this one gets for free.
//
// FETCH: the 2026-07-03 survey-cron contract — `redirect: 'manual'`, any redirect
// or non-200 is a FAILURE, logged bodies truncated. A followed 307 → /login would
// turn the login page's 200 into a "successful" scan that escalated nothing.

import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  nextHourlyFireInstant,
  runFireOnce,
  truncateBody,
} from '../../scripts/ap-escalation-scan.mjs';

describe('nextHourlyFireInstant', () => {
  it('lands on the next :10 past the hour', () => {
    const fire = nextHourlyFireInstant(new Date('2026-07-28T14:03:00Z'), 10);
    expect(fire.toISOString()).toBe('2026-07-28T14:10:00.000Z');
  });

  it('rolls to the next hour when :10 has already passed', () => {
    const fire = nextHourlyFireInstant(new Date('2026-07-28T14:10:00Z'), 10);
    expect(fire.toISOString()).toBe('2026-07-28T15:10:00.000Z');
  });

  it('rolls the day (and the month) cleanly', () => {
    const fire = nextHourlyFireInstant(new Date('2026-07-31T23:59:00Z'), 10);
    expect(fire.toISOString()).toBe('2026-08-01T00:10:00.000Z');
  });

  // The DST days that forced the offset-reprobe rewrite on every wall-clock
  // daemon: fall-back 2026-11-01 (the 25h Pacific day) and spring-forward
  // 2027-03-14 (the 23h Pacific day). An hourly cadence must be untouched by both.
  it.each([
    ['fall-back 2026-11-01', '2026-11-01T08:30:00Z'],
    ['spring-forward 2027-03-14', '2027-03-14T09:30:00Z'],
  ])('keeps an exactly-hourly cadence across %s', (_label, iso) => {
    let cursor = new Date(iso);
    for (let i = 0; i < 6; i++) {
      const next = nextHourlyFireInstant(cursor, 10);
      expect(next.getTime() - cursor.getTime()).toBeGreaterThan(0);
      expect(next.getUTCMinutes()).toBe(10);
      const after = nextHourlyFireInstant(next, 10);
      expect(after.getTime() - next.getTime()).toBe(3_600_000);
      cursor = next;
    }
  });
});

describe('truncateBody', () => {
  it('passes short bodies through and truncates long ones', () => {
    expect(truncateBody('short')).toBe('short');
    expect(truncateBody('x'.repeat(1000))).toMatch(/truncated 1000 chars/);
  });
});

describe('runFireOnce fetch contract', () => {
  function stubFetch(status: number, body: string, headers: Record<string, string> = {}) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      return new Response(body, { status, headers });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the body on a direct 200', async () => {
    stubFetch(200, '{"scanned":3,"escalated":1}');
    await expect(runFireOnce()).resolves.toContain('"escalated":1');
  });

  it('throws on a 307 login redirect instead of following it', async () => {
    stubFetch(307, '', { location: '/login?next=%2Fapi%2Finternal%2Fap' });
    await expect(runFireOnce()).rejects.toThrow(/HTTP 307.*\/login/s);
  });

  it('throws on a 500 — a failed scan is never a successful tick', async () => {
    stubFetch(500, 'x'.repeat(1000));
    await expect(runFireOnce()).rejects.toThrow(/HTTP 500.*truncated 1000 chars/s);
  });

  it('POSTs the escalation-scan route', async () => {
    const f = stubFetch(200, 'ok');
    await runFireOnce();
    expect(f.mock.calls[0]?.[0]).toMatch(/\/api\/internal\/ap\/escalation-scan$/);
    expect(f.mock.calls[0]?.[1]?.method).toBe('POST');
  });
});
