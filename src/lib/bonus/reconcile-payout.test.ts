// P0-1 / P0-2 — pure reconciliation logic tests (ADR-0033).
//
// No DB, no network — the decision functions are pure. Exhaustively covers the
// reconciled-state matrix, the historical/legacy carve-outs, and the suspected-
// wrong-$0 predicate (the heart of P0-2: a $0 that DISAGREES is blocked; a $0
// that AGREES is allowed).

import { describe, it, expect } from 'vitest';
import {
  reconcilePayout,
  isSuspectedWrongZero,
  RECONCILED_STATES,
} from '@/lib/bonus/reconcile-payout';

describe('reconcilePayout — P0-1 tripwire', () => {
  it('passes (reconciled) on an exact integer match for a signed period', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'signed',
      lockedTotalCents: 212550,
      recomputedTotalCents: 212550,
    });
    expect(v).toEqual({ ok: true, reconciled: true });
  });

  it('passes (reconciled) for a paid period that matches', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'paid',
      lockedTotalCents: 50000,
      recomputedTotalCents: 50000,
    });
    expect(v.ok).toBe(true);
    expect(v).toMatchObject({ reconciled: true });
  });

  it('FAILS total_mismatch when locked disagrees with recompute (tonight: $0 lock vs $2,125.50)', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'signed',
      lockedTotalCents: 0,
      recomputedTotalCents: 212550,
    });
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({
      reason: 'total_mismatch',
      lockedTotalCents: 0,
      recomputedTotalCents: 212550,
    });
  });

  it('FAILS total_mismatch for any disagreement, not just zero', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'paid',
      lockedTotalCents: 212550,
      recomputedTotalCents: 212525, // off by a quarter
    });
    expect(v).toMatchObject({ ok: false, reason: 'total_mismatch' });
  });

  it('FAILS missing_locked_total when a signed period has a NULL locked total', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'signed',
      lockedTotalCents: null,
      recomputedTotalCents: 212550,
    });
    expect(v).toMatchObject({ ok: false, reason: 'missing_locked_total' });
  });

  it('is a no-op (reconciled:false) for non-reconciled states even on a mismatch', () => {
    for (const state of ['draft', 'pending_signatures', 'partially_signed', 'amended']) {
      const v = reconcilePayout({
        monthId: 'm1',
        state,
        lockedTotalCents: 0,
        recomputedTotalCents: 999, // would be a mismatch if it applied
      });
      expect(v).toEqual({ ok: true, reconciled: false });
    }
  });

  it('is a no-op for historical_imported (legacy as-paid total differs by design)', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'historical_imported',
      lockedTotalCents: 999,
      recomputedTotalCents: 1234,
    });
    expect(v).toEqual({ ok: true, reconciled: false });
  });

  it('is a no-op when importedWithLegacyFormula is set, regardless of state', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'signed', // even a reconciled state
      lockedTotalCents: 100,
      recomputedTotalCents: 200,
      importedWithLegacyFormula: true,
    });
    expect(v).toEqual({ ok: true, reconciled: false });
  });

  it('reconciles a legitimate $0 (sub-threshold) that matches', () => {
    const v = reconcilePayout({
      monthId: 'm1',
      state: 'signed',
      lockedTotalCents: 0,
      recomputedTotalCents: 0,
    });
    expect(v).toEqual({ ok: true, reconciled: true });
  });

  it('RECONCILED_STATES is exactly {signed, paid}', () => {
    expect([...RECONCILED_STATES].sort()).toEqual(['paid', 'signed']);
  });
});

describe('isSuspectedWrongZero — P0-2 predicate', () => {
  it('blocks a $0 lock that DISAGREES with a positive recompute', () => {
    expect(isSuspectedWrongZero({ lockedTotalCents: 0, recomputedTotalCents: 212550 })).toBe(true);
  });

  it('allows a $0 lock that AGREES with a $0 recompute (genuinely sub-threshold)', () => {
    expect(isSuspectedWrongZero({ lockedTotalCents: 0, recomputedTotalCents: 0 })).toBe(false);
  });

  it('does not apply when the locked total is positive', () => {
    expect(isSuspectedWrongZero({ lockedTotalCents: 100, recomputedTotalCents: 200 })).toBe(false);
  });

  it('does not apply when the locked total is null (that is reconcile’s missing_locked_total)', () => {
    expect(isSuspectedWrongZero({ lockedTotalCents: null, recomputedTotalCents: 212550 })).toBe(
      false,
    );
  });
});
