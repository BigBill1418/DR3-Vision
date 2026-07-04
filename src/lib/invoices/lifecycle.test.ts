import { describe, expect, it } from 'vitest';
import { canApprove, type ApproverContext } from './lifecycle';
import { assertTotalMatchesLines, InvoiceInvariantError } from './view';

function ctx(over: Partial<ApproverContext> = {}): ApproverContext {
  return { userId: 'u1', role: 'manager', managesSite: true, ...over };
}

describe('canApprove (D4 approver rule)', () => {
  it('admin approves unconditionally', () => {
    expect(canApprove(ctx({ role: 'admin', managesSite: false }))).toBe(true);
  });

  it('manager-of-site approves', () => {
    expect(canApprove(ctx({ role: 'manager', managesSite: true }))).toBe(true);
  });

  it('manager NOT of this site cannot approve', () => {
    expect(canApprove(ctx({ role: 'manager', managesSite: false }))).toBe(false);
  });

  it('operator cannot approve', () => {
    expect(canApprove(ctx({ role: 'operator', managesSite: true }))).toBe(false);
  });

  it('can_manage_rates is NOT sufficient — it is not even an input to canApprove', () => {
    // A rate-manager who is a plain manager NOT of this site (the only way
    // can_manage_rates could matter) is still refused: the flag never enters the
    // decision. Simulate by asserting the type has no can_manage_rates field and
    // the off-site manager is denied regardless.
    const offSiteRateManager = ctx({ role: 'manager', managesSite: false });
    expect(canApprove(offSiteRateManager)).toBe(false);
    // And the ApproverContext shape carries no rates flag at all:
    expect('can_manage_rates' in offSiteRateManager).toBe(false);
  });
});

describe('assertTotalMatchesLines (total_cents invariant, ADR-0033 tripwire)', () => {
  it('passes when stored total equals Σ lines (incl. a negative offset line)', () => {
    expect(() =>
      assertTotalMatchesLines('inv1', 100, [{ amountCents: 150 }, { amountCents: -50 }]),
    ).not.toThrow();
  });

  it('throws with both numbers when the stored total disagrees', () => {
    try {
      assertTotalMatchesLines('inv1', 999, [{ amountCents: 150 }, { amountCents: -50 }]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvoiceInvariantError);
      expect((e as InvoiceInvariantError).context).toEqual({ invoiceId: 'inv1', storedTotal: 999, lineSum: 100 });
    }
  });

  it('empty lines require a 0 total', () => {
    expect(() => assertTotalMatchesLines('inv1', 0, [])).not.toThrow();
    expect(() => assertTotalMatchesLines('inv1', 1, [])).toThrow(InvoiceInvariantError);
  });
});
