// T-205 smoke + schedule test for the escalation cron daemon
// (`scripts/bonus-escalation-check.mjs`).
//
// The daemon is a thin Pacific-aware scheduler that POSTs the internal
// escalation route per tier; the orchestration (ntfy / auto-override / deadline)
// is covered by `src/lib/bonus/escalation.test.ts` and the route test. Here we
// verify (a) the module imports without starting the daemon, and (b) the
// load-bearing "next fire" computation lands on the right Pacific tier time
// across both DST regimes.

import { describe, it, expect } from 'vitest';
import { nextEscalationFire } from '../../../../scripts/bonus-escalation-check.mjs';

/** The Pacific wall-clock "HH:MM" an absolute UTC delta from `from` lands on. */
function pacificHHMM(from: Date, deltaMs: number): string {
  const at = new Date(from.getTime() + deltaMs);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

describe('bonus-escalation cron — nextEscalationFire', () => {
  it('imports the daemon module without starting it (no throw, helper exported)', () => {
    expect(typeof nextEscalationFire).toBe('function');
  });

  it('picks t1 06:00 PT when before all fires (summer PDT)', () => {
    // 2026-07-15 05:00 PDT = 12:00 UTC. Next fire is t1 at 06:00 PDT same day.
    const from = new Date('2026-07-15T12:00:00Z');
    const next = nextEscalationFire(from);
    expect(next.tier).toBe('t1');
    expect(pacificHHMM(from, next.delay)).toBe('06:00');
  });

  it('picks t2 07:30 PT when between 06:00 and 07:30', () => {
    // 2026-07-15 06:30 PDT = 13:30 UTC. Next fire is t2 at 07:30 PDT.
    const from = new Date('2026-07-15T13:30:00Z');
    const next = nextEscalationFire(from);
    expect(next.tier).toBe('t2');
    expect(pacificHHMM(from, next.delay)).toBe('07:30');
  });

  it('picks t3 08:30 PT when between 07:30 and 08:30', () => {
    // 2026-07-15 08:00 PDT = 15:00 UTC.
    const from = new Date('2026-07-15T15:00:00Z');
    const next = nextEscalationFire(from);
    expect(next.tier).toBe('t3');
    expect(pacificHHMM(from, next.delay)).toBe('08:30');
  });

  it('picks t4 09:00 PT when between 08:30 and 09:00', () => {
    // 2026-07-15 08:45 PDT = 15:45 UTC.
    const from = new Date('2026-07-15T15:45:00Z');
    const next = nextEscalationFire(from);
    expect(next.tier).toBe('t4');
    expect(pacificHHMM(from, next.delay)).toBe('09:00');
  });

  it('rolls to next-day t1 after 09:00 PT', () => {
    // 2026-07-15 10:00 PDT = 17:00 UTC. All today fired → tomorrow 06:00 t1.
    const from = new Date('2026-07-15T17:00:00Z');
    const next = nextEscalationFire(from);
    expect(next.tier).toBe('t1');
    expect(pacificHHMM(from, next.delay)).toBe('06:00');
    expect(next.delay).toBeGreaterThan(0);
    expect(next.delay).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('lands on the right Pacific tier time in winter (PST, -8)', () => {
    // 2026-01-15 05:00 PST = 13:00 UTC. Next is t1 06:00 PST.
    const from = new Date('2026-01-15T13:00:00Z');
    const next = nextEscalationFire(from);
    expect(next.tier).toBe('t1');
    expect(pacificHHMM(from, next.delay)).toBe('06:00');
  });

  it('every computed fire lands exactly on its tier wall-clock time across a day', () => {
    const expected: Record<string, string> = {
      t1: '06:00',
      t2: '07:30',
      t3: '08:30',
      t4: '09:00',
    };
    const base = Date.UTC(2026, 5, 1, 0, 0, 0); // Jun 1 2026 (PDT)
    for (let h = 0; h < 24; h++) {
      const from = new Date(base + h * 60 * 60 * 1000);
      const next = nextEscalationFire(from);
      expect(pacificHHMM(from, next.delay)).toBe(expected[next.tier]);
      expect(next.delay).toBeGreaterThan(0);
    }
  });
});
