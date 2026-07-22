// ADR-0056 amendment (Addendum A §A.3) — TONU is gated to dr3_hauled = true.
// A TONU is DR3 dispatching a trailer; it can only fire in Mode A. When a
// customer / third party hauled (Mode B, dr3_hauled = false) DR3 never
// dispatched, so there is no TONU to bill — even if a stray dispatch/cancel/
// divert flag is present on the record.

import { describe, it, expect } from 'vitest';
import { assessTonu, TonuHaulRateUnavailableError, type TonuInput } from './tonu';

const HAUL_CENTS = 45000;
const t = (iso: string) => new Date(iso);

function tonu(over: Partial<TonuInput> = {}): TonuInput {
  return {
    dr3Hauled: true,
    dispatchedAt: null,
    cancelledAt: null,
    diverted: false,
    haulRateCents: HAUL_CENTS,
    ...over,
  };
}

describe('assessTonu — §A.3 dr3_hauled gate (only DR3-dispatched hauls bill)', () => {
  it('Mode B (dr3_hauled=false) never bills even when it would otherwise (cancelled after dispatch)', () => {
    expect(
      assessTonu(
        tonu({
          dr3Hauled: false,
          dispatchedAt: t('2026-06-10T08:00:00Z'),
          cancelledAt: t('2026-06-10T12:00:00Z'),
        }),
      ),
    ).toEqual({ billable: false, reason: 'not_dr3_hauled' });
  });

  it('Mode B never bills even when diverted (independent trigger is still gated out)', () => {
    expect(
      assessTonu(tonu({ dr3Hauled: false, dispatchedAt: t('2026-06-10T08:00:00Z'), diverted: true })),
    ).toEqual({ billable: false, reason: 'not_dr3_hauled' });
  });

  it('the gate runs FIRST — a null haul rate on a Mode-B billable-shaped order does NOT throw', () => {
    expect(
      assessTonu(
        tonu({
          dr3Hauled: false,
          dispatchedAt: t('2026-06-10T08:00:00Z'),
          diverted: true,
          haulRateCents: null,
        }),
      ),
    ).toEqual({ billable: false, reason: 'not_dr3_hauled' });
  });

  it('Mode A (dr3_hauled=true) still bills a cancelled-after-dispatch TONU (gate does not break the happy path)', () => {
    expect(
      assessTonu(
        tonu({
          dr3Hauled: true,
          dispatchedAt: t('2026-06-10T08:00:00Z'),
          cancelledAt: t('2026-06-10T12:00:00Z'),
        }),
      ),
    ).toEqual({ billable: true, reason: 'cancelled_after_dispatch', billedCents: HAUL_CENTS });
  });

  it('Mode A with a billable TONU + null haul rate still fails loud (gate passed, rate refusal intact)', () => {
    expect(() =>
      assessTonu(
        tonu({ dr3Hauled: true, dispatchedAt: t('2026-06-10T08:00:00Z'), diverted: true, haulRateCents: null }),
      ),
    ).toThrow(TonuHaulRateUnavailableError);
  });
});
