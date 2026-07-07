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
// Pacific-aware "next 07:00 PT" computation lands on the right UTC instant
// across both DST regimes (PDT -7 in summer, PST -8 in winter). ADR-0019.1
// 2026-07-07 amendment moved the close from 17:30 (period_end day) to 07:00
// (payroll day, the day after period_end).

import { describe, it, expect } from 'vitest';
// Import the .mjs helper directly (it guards its daemon auto-start behind an
// entrypoint check, so importing it here spawns no timers).
import { msUntilNext0700Pacific } from '../../../../scripts/bonus-period-close.mjs';

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

describe('bonus-period-close cron — msUntilNext0700Pacific', () => {
  it('imports the daemon module without starting it (no throw, helper exported)', () => {
    expect(typeof msUntilNext0700Pacific).toBe('function');
  });

  it('targets 07:00 Pacific in summer (PDT, -7) — same-day when before 07:00', () => {
    // 2026-07-15 05:00 PDT = 12:00 UTC. Next fire is 07:00 PDT the same day.
    const from = new Date('2026-07-15T12:00:00Z');
    const delta = msUntilNext0700Pacific(from);
    expect(pacificHHMM(from, delta)).toBe('07:00');
    // 2h until 07:00 PDT.
    expect(delta).toBe(2 * 60 * 60 * 1000);
  });

  it('rolls to the next day when the Pacific wall clock is already past 07:00', () => {
    // 2026-07-15 08:00 PDT = 15:00 UTC. Next fire is tomorrow 07:00 PDT.
    const from = new Date('2026-07-15T15:00:00Z');
    const delta = msUntilNext0700Pacific(from);
    expect(pacificHHMM(from, delta)).toBe('07:00');
    expect(delta).toBeGreaterThan(0);
    // Within (0, 24h]; specifically ~23h here.
    expect(delta).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('targets 07:00 Pacific in winter (PST, -8)', () => {
    // 2026-01-15 05:00 PST = 13:00 UTC. Next fire is 07:00 PST the same day.
    const from = new Date('2026-01-15T13:00:00Z');
    const delta = msUntilNext0700Pacific(from);
    expect(pacificHHMM(from, delta)).toBe('07:00');
    expect(delta).toBe(2 * 60 * 60 * 1000);
  });

  it('lands exactly on 07:00 Pacific regardless of the from-instant', () => {
    // Sweep a day of from-instants; every computed fire must read 07:00 PT.
    const base = Date.UTC(2026, 5, 1, 0, 0, 0); // Jun 1 2026 (PDT)
    for (let h = 0; h < 24; h++) {
      const from = new Date(base + h * 60 * 60 * 1000);
      const delta = msUntilNext0700Pacific(from);
      expect(pacificHHMM(from, delta)).toBe('07:00');
      expect(delta).toBeGreaterThan(0);
    }
  });

  it('lands on 07:00 across the spring-forward DST boundary (2026-03-08)', () => {
    // 2026-03-08 is the PST→PDT transition. From the day before, the next 07:00
    // must still read 07:00 wall-clock (offset changes mid-window).
    const from = new Date('2026-03-08T06:00:00Z'); // before that day's 07:00 PT
    const delta = msUntilNext0700Pacific(from);
    expect(pacificHHMM(from, delta)).toBe('07:00');
    expect(delta).toBeGreaterThan(0);
  });
});
