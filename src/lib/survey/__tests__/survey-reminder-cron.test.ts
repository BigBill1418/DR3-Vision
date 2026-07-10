// ADR-0036 — smoke + schedule test for the reminder cron daemon
// (`scripts/survey-reminder-cron.mjs`).
//
// The daemon is a thin Pacific-aware scheduler that POSTs the internal
// reminder-tick route; the orchestration is covered by `reminders.test.ts` and
// the route test. Here we verify (a) the module imports without starting the
// daemon, and (b) the load-bearing "next fire" computation lands exactly on
// 09:00 Pacific across both DST regimes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  nextFireInstantAt,
  runFireOnce,
  truncateBody,
} from '../../../../scripts/survey-reminder-cron.mjs';

/** The Pacific wall-clock "HH:MM" an absolute UTC instant lands on. */
function pacificHHMM(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

describe('survey-reminder cron — nextFireInstantAt', () => {
  it('imports the daemon module without starting it (helper exported)', () => {
    expect(typeof nextFireInstantAt).toBe('function');
  });

  it('lands on 09:00 PDT when before the fire (summer)', () => {
    // 2026-07-15 05:00 PDT = 12:00 UTC → next fire is 09:00 PDT same day.
    const from = new Date('2026-07-15T12:00:00Z');
    const fire = nextFireInstantAt(from, 9, 0);
    expect(pacificHHMM(fire)).toBe('09:00');
    expect(fire.getTime()).toBeGreaterThan(from.getTime());
  });

  it('rolls to next-day 09:00 PDT when after the fire', () => {
    // 2026-07-15 10:00 PDT = 17:00 UTC → tomorrow 09:00 PDT.
    const from = new Date('2026-07-15T17:00:00Z');
    const fire = nextFireInstantAt(from, 9, 0);
    expect(pacificHHMM(fire)).toBe('09:00');
    const deltaMs = fire.getTime() - from.getTime();
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('lands on 09:00 PST in winter (-8)', () => {
    // 2026-01-15 05:00 PST = 13:00 UTC → 09:00 PST same day.
    const from = new Date('2026-01-15T13:00:00Z');
    const fire = nextFireInstantAt(from, 9, 0);
    expect(pacificHHMM(fire)).toBe('09:00');
  });

  it('every computed fire across a day lands exactly on 09:00 Pacific', () => {
    const base = Date.UTC(2026, 5, 1, 0, 0, 0); // Jun 1 2026 (PDT)
    for (let h = 0; h < 24; h++) {
      const from = new Date(base + h * 60 * 60 * 1000);
      const fire = nextFireInstantAt(from, 9, 0);
      expect(pacificHHMM(fire)).toBe('09:00');
      expect(fire.getTime()).toBeGreaterThan(from.getTime());
    }
  });
});

// DST-transition regression for the offset-reprobe port (stack-sweep 2026-07-10).
// The prior "delta seconds-of-day added to `from`" scheduler assumed every Pacific
// day is 86400s, so it misfired across the twice-yearly DST shifts. These pin the
// two transition days the fleet crosses.
describe('survey-reminder cron — DST transition days', () => {
  it('fires exactly ONCE at 09:00 PT on fall-back day (2026-11-01), then rolls to the next day', () => {
    // 2026-11-01 02:00 PDT → 01:00 PST is a 25h Pacific day. The naive scheduler
    // landed 1h early (08:00) and then re-fired at the real 09:00 — a DOUBLE FIRE.
    const from = new Date('2026-11-01T07:30:00Z'); // Nov 1 00:30 PDT (before the 02:00 fall-back)
    const fire1 = nextFireInstantAt(from, 9, 0);
    expect(pacificHHMM(fire1)).toBe('09:00');
    expect(fire1.toISOString()).toBe('2026-11-01T17:00:00.000Z'); // 09:00 PST (-8)
    // Re-arming from just after fire1 must roll to the NEXT day — not re-fire Nov 1.
    const fire2 = nextFireInstantAt(fire1, 9, 0);
    expect(pacificHHMM(fire2)).toBe('09:00');
    expect(fire2.toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });

  it('fires at 09:00 PT (not 10:00) on spring-forward day (2027-03-14)', () => {
    // 2027-03-14 02:00 PST → 03:00 PDT is a 23h Pacific day. The naive scheduler
    // fired 1h LATE (10:00).
    const from = new Date('2027-03-14T08:30:00Z'); // Mar 14 00:30 PST (before the 02:00 spring-forward)
    const fire = nextFireInstantAt(from, 9, 0);
    expect(pacificHHMM(fire)).toBe('09:00');
    expect(fire.toISOString()).toBe('2027-03-14T16:00:00.000Z'); // 09:00 PDT (-7)
  });
});

// Regression for 2026-07-03: the auth middleware (missing the
// /api/internal/survey/ exemption) 307'd the tick POST to /login; fetch's
// default redirect-following turned that into the login page's 200 and the
// daemon logged a "successful" tick that sent nothing. runFireOnce must treat
// ANY redirect or non-200 as a failure and never follow redirects.
describe('survey-reminder cron — runFireOnce', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: string, headers: Record<string, string> = {}) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      // The daemon must ask fetch NOT to follow redirects.
      expect(init.redirect).toBe('manual');
      return new Response(status === 204 ? null : body, { status, headers });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns the body on a direct 200', async () => {
    stubFetch(200, '{"ok":true,"remindersSent":2}');
    await expect(runFireOnce()).resolves.toContain('"remindersSent":2');
  });

  it('throws on a 307 login redirect instead of following it', async () => {
    stubFetch(307, '', { location: '/login?next=%2Fapi%2Finternal%2Fsurvey%2Freminder-tick' });
    await expect(runFireOnce()).rejects.toThrow(/HTTP 307.*\/login/s);
  });

  it('throws on a non-200 with the (truncated) body in the message', async () => {
    stubFetch(503, 'x'.repeat(1000));
    await expect(runFireOnce()).rejects.toThrow(/HTTP 503.*truncated 1000 chars/s);
  });

  it('truncateBody caps long bodies and passes short ones through', () => {
    expect(truncateBody('short')).toBe('short');
    const long = truncateBody('y'.repeat(500));
    expect(long.length).toBeLessThan(400);
    expect(long).toContain('[truncated 500 chars]');
  });
});
