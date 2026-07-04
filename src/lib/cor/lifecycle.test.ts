import { describe, expect, it } from 'vitest';
import { canFinalize, type FinalizerContext } from './lifecycle';

function ctx(over: Partial<FinalizerContext> = {}): FinalizerContext {
  return { userId: 'u1', role: 'manager', managesSite: true, ...over };
}

describe('canFinalize (D3 finalizer rule — mirrors ADR-0041 approver)', () => {
  it('admin finalizes unconditionally', () => {
    expect(canFinalize(ctx({ role: 'admin', managesSite: false }))).toBe(true);
  });

  it('manager-of-site finalizes', () => {
    expect(canFinalize(ctx({ role: 'manager', managesSite: true }))).toBe(true);
  });

  it('manager NOT of this site cannot finalize (an all-sites manager has reach, not finalize authority)', () => {
    expect(canFinalize(ctx({ role: 'manager', managesSite: false }))).toBe(false);
  });

  it('operator cannot finalize', () => {
    expect(canFinalize(ctx({ role: 'operator', managesSite: true }))).toBe(false);
  });

  it('can_manage_rates is not even an input to the decision', () => {
    const c = ctx({ role: 'manager', managesSite: false });
    expect('can_manage_rates' in c).toBe(false);
    expect(canFinalize(c)).toBe(false);
  });
});
