// ADR-0065 — the server-side current-day pin for the floor write paths.
//
// Hiding other days in the UI is not a control. `/api/operator/[site]/inbound`
// and `/api/operator/[site]/processed` take the target day in the request body,
// so without this an operator (or a replayed offline-queue entry) could confirm
// counts against another day by editing it. These writes feed `onHand` and
// billing, so this is money-safety, not cosmetics.

import { describe, it, expect, vi } from 'vitest';

// `route-helpers` also exports the auth-bound guards, whose module graph pulls
// next-auth → `next/server` (unresolvable under the vitest node resolver). The
// day pin under test is pure; stub the auth module to keep the graph loadable.
vi.mock('@/lib/auth-helpers', () => ({
  requireManagerForSite: async () => ({}),
  requireOperatorForSite: async () => ({}),
}));

import { assertCurrentPacificDay } from './route-helpers';

/** 6:00 PM Pacific on 2026-07-28 (PDT) — UTC has already rolled to 07-29. */
const SIX_PM_PACIFIC = new Date('2026-07-29T01:00:00Z');

describe('assertCurrentPacificDay', () => {
  it('accepts the current PACIFIC day even when UTC has already rolled over', () => {
    expect(() => assertCurrentPacificDay('2026-07-28', SIX_PM_PACIFIC)).not.toThrow();
  });

  it('rejects the UTC day during the evening window (the trap)', () => {
    // Server-local (UTC) "today" is 07-29 at this instant. A pin written against
    // the server day would accept tomorrow and reject the operator's real day.
    expect(() => assertCurrentPacificDay('2026-07-29', SIX_PM_PACIFIC)).toThrow();
  });

  it('rejects a past day (no historical writes from the floor)', () => {
    expect(() => assertCurrentPacificDay('2026-07-27', SIX_PM_PACIFIC)).toThrow();
  });

  it('rejects rather than silently retargeting to today', () => {
    // Silently rewriting the day would file units against the wrong production
    // day — worse than a visible refusal.
    let thrown: unknown;
    try {
      assertCurrentPacificDay('2026-01-01', SIX_PM_PACIFIC);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(422);
    expect((thrown as Response).statusText).toBe('date_not_today');
  });

  it('works in PST (winter) as well as PDT', () => {
    const winterEvening = new Date('2026-01-15T02:00:00Z'); // 6 PM PST on 01-14
    expect(() => assertCurrentPacificDay('2026-01-14', winterEvening)).not.toThrow();
    expect(() => assertCurrentPacificDay('2026-01-15', winterEvening)).toThrow();
  });
});
