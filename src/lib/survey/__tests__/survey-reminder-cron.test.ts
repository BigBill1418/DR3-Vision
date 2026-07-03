// ADR-0036 — smoke + schedule test for the reminder cron daemon
// (`scripts/survey-reminder-cron.mjs`).
//
// The daemon is a thin Pacific-aware scheduler that POSTs the internal
// reminder-tick route; the orchestration is covered by `reminders.test.ts` and
// the route test. Here we verify (a) the module imports without starting the
// daemon, and (b) the load-bearing "next fire" computation lands exactly on
// 09:00 Pacific across both DST regimes.

import { describe, it, expect } from 'vitest';
import { nextFireInstantAt } from '../../../../scripts/survey-reminder-cron.mjs';

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
