// ADR-0056 — TONU billability. Pure: Rick's four cases (§5.3) + the fail-loud
// refusal when a billable TONU has no haul rate, + the record-shape verdict.

import { describe, it, expect } from 'vitest';
import { assessTonu, TonuHaulRateUnavailableError, type TonuInput } from './tonu';

const HAUL_CENTS = 45000; // stub Primary haul rate

function tonu(over: Partial<TonuInput> = {}): TonuInput {
  return {
    dispatchedAt: null,
    cancelledAt: null,
    diverted: false,
    haulRateCents: HAUL_CENTS,
    ...over,
  };
}

const t = (iso: string) => new Date(iso);

describe('assessTonu — Rick’s billability rules (§5.3)', () => {
  it('cancelled BEFORE dispatch → NO bill', () => {
    const a = assessTonu(
      tonu({ dispatchedAt: t('2026-06-10T15:00:00Z'), cancelledAt: t('2026-06-10T09:00:00Z') }),
    );
    expect(a).toEqual({ billable: false, reason: 'cancelled_before_dispatch' });
  });

  it('cancelled AFTER dispatch → billed at haul rate', () => {
    const a = assessTonu(
      tonu({ dispatchedAt: t('2026-06-10T08:00:00Z'), cancelledAt: t('2026-06-10T12:00:00Z') }),
    );
    expect(a).toEqual({ billable: true, reason: 'cancelled_after_dispatch', billedCents: HAUL_CENTS });
  });

  it('diverted → billed at haul rate (independent trigger, wins over cancel timing)', () => {
    const a = assessTonu(
      tonu({
        diverted: true,
        dispatchedAt: t('2026-06-10T08:00:00Z'),
        cancelledAt: t('2026-06-10T07:00:00Z'), // would be "before dispatch", but diverted wins
      }),
    );
    expect(a).toEqual({ billable: true, reason: 'diverted', billedCents: HAUL_CENTS });
  });

  it('never dispatched → NO bill', () => {
    expect(assessTonu(tonu())).toEqual({ billable: false, reason: 'not_dispatched' });
  });

  it('dispatched, not cancelled, not diverted → nothing to bill', () => {
    expect(assessTonu(tonu({ dispatchedAt: t('2026-06-10T08:00:00Z') }))).toEqual({
      billable: false,
      reason: 'not_dispatched',
    });
  });
});

describe('assessTonu — fail loud when billable but haul rate unseeded', () => {
  it('refuses a cancelled-after-dispatch TONU with a null haul rate', () => {
    expect(() =>
      assessTonu(
        tonu({
          dispatchedAt: t('2026-06-10T08:00:00Z'),
          cancelledAt: t('2026-06-10T12:00:00Z'),
          haulRateCents: null,
        }),
      ),
    ).toThrow(TonuHaulRateUnavailableError);
  });

  it('refuses a diverted TONU with a null haul rate', () => {
    expect(() => assessTonu(tonu({ diverted: true, haulRateCents: null }))).toThrow(
      TonuHaulRateUnavailableError,
    );
  });
});
