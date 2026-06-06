// T-204 smoke + schedule test for the period-close cron daemon
// (`scripts/bonus-period-close.mjs`).
//
// The daemon itself is a thin Pacific-aware scheduler that POSTs the internal
// close route; the transition + signature-email orchestration (and its
// idempotency) is covered by:
//   - `src/app/api/internal/bonus/close-months/close-months.route.test.ts`
//   - `src/lib/bonus/__tests__/state-machine.*.test.ts` (closePayPeriodsDueForSignature)
//
// Here we verify (a) the module imports without throwing / without starting the
// daemon (no entrypoint side-effects under test), and (b) the load-bearing
// Pacific-aware "next 17:30 PT" computation lands on the right UTC instant
// across both DST regimes (PDT -7 in summer, PST -8 in winter).

import { describe, it, expect } from 'vitest';
// Import the .mjs helper directly (it guards its daemon auto-start behind an
// entrypoint check, so importing it here spawns no timers).
import { msUntilNext1730Pacific } from '../../../../scripts/bonus-period-close.mjs';

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

describe('bonus-period-close cron — msUntilNext1730Pacific', () => {
  it('imports the daemon module without starting it (no throw, helper exported)', () => {
    expect(typeof msUntilNext1730Pacific).toBe('function');
  });

  it('targets 17:30 Pacific in summer (PDT, -7) — same-day when before 17:30', () => {
    // 2026-07-15 10:00 PDT = 17:00 UTC. Next fire is 17:30 PDT the same day.
    const from = new Date('2026-07-15T17:00:00Z');
    const delta = msUntilNext1730Pacific(from);
    expect(pacificHHMM(from, delta)).toBe('17:30');
    // 7.5h until 17:30 PDT.
    expect(delta).toBe(7.5 * 60 * 60 * 1000);
  });

  it('rolls to the next day when the Pacific wall clock is already past 17:30', () => {
    // 2026-07-15 18:00 PDT = 2026-07-16 01:00 UTC. Next fire is tomorrow 17:30 PDT.
    const from = new Date('2026-07-16T01:00:00Z');
    const delta = msUntilNext1730Pacific(from);
    expect(pacificHHMM(from, delta)).toBe('17:30');
    expect(delta).toBeGreaterThan(0);
    // Within (0, 24h]; specifically ~23.5h here.
    expect(delta).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('targets 17:30 Pacific in winter (PST, -8)', () => {
    // 2026-01-15 09:00 PST = 17:00 UTC. Next fire is 17:30 PST the same day.
    const from = new Date('2026-01-15T17:00:00Z');
    const delta = msUntilNext1730Pacific(from);
    expect(pacificHHMM(from, delta)).toBe('17:30');
    expect(delta).toBe(8.5 * 60 * 60 * 1000);
  });

  it('lands exactly on 17:30 Pacific regardless of the from-instant', () => {
    // Sweep a day of from-instants; every computed fire must read 17:30 PT.
    const base = Date.UTC(2026, 5, 1, 0, 0, 0); // Jun 1 2026 (PDT)
    for (let h = 0; h < 24; h++) {
      const from = new Date(base + h * 60 * 60 * 1000);
      const delta = msUntilNext1730Pacific(from);
      expect(pacificHHMM(from, delta)).toBe('17:30');
      expect(delta).toBeGreaterThan(0);
    }
  });
});
