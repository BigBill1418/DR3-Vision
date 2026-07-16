// 2026-07-09 rollup §1.4 — the credit-memo state machine, pure parts.
// (DB orchestration is exercised at the route level; the machine itself —
// which jumps are legal — is the money-critical invariant and tests pure.)

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  CreditMemoTransitionError,
  CreditMemoValidationError,
  assertWithinCumulativeCap,
  type CreditMemoStatus,
} from './credit-memos';

const ALL: CreditMemoStatus[] = [
  'proposed',
  'sent_to_mrc',
  'accepted',
  'rejected',
  'applied',
  'void_and_reissue_triggered',
];

describe('credit-memo state machine (rollup §1.4)', () => {
  it('encodes exactly the Mary-described flow', () => {
    expect(ALLOWED_TRANSITIONS.proposed).toEqual(['sent_to_mrc']);
    expect(ALLOWED_TRANSITIONS.sent_to_mrc).toEqual(['accepted', 'rejected']);
    expect(ALLOWED_TRANSITIONS.accepted).toEqual(['applied']);
    expect(ALLOWED_TRANSITIONS.rejected).toEqual(['void_and_reissue_triggered']);
  });

  it('applied and void_and_reissue_triggered are terminal', () => {
    expect(ALLOWED_TRANSITIONS.applied).toEqual([]);
    expect(ALLOWED_TRANSITIONS.void_and_reissue_triggered).toEqual([]);
  });

  it('a credit can never apply without MRC acceptance (no proposed→applied shortcut)', () => {
    // The §1.4 hard requirement: MRC agreement is REQUIRED before applying.
    // Every path to `applied` must pass through `accepted`.
    for (const from of ALL) {
      if (from === 'accepted') continue;
      expect(ALLOWED_TRANSITIONS[from]).not.toContain('applied');
    }
  });

  it('rejection can only fall back to void-and-reissue, never silently apply', () => {
    expect(ALLOWED_TRANSITIONS.rejected).not.toContain('applied');
    expect(ALLOWED_TRANSITIONS.rejected).not.toContain('accepted');
  });

  it('the transition error names the from/to and the allowed set', () => {
    const e = new CreditMemoTransitionError('proposed', 'applied');
    expect(e.status).toBe(409);
    expect(e.message).toContain('proposed → applied');
    expect(e.message).toContain('sent_to_mrc');
  });
});

// M3 — the cumulative cap. The per-memo bound (≤ total) alone let a fresh memo up
// to the full total be raised after an earlier one applied, so Σ credits could
// exceed the invoice. `assertWithinCumulativeCap` is the money invariant, pure.
describe('assertWithinCumulativeCap (M3 — Σ credits ≤ invoice total)', () => {
  const base = { invoiceId: 'inv-1', invoiceTotalCents: 100_00 };

  it('allows a memo that fits within the remaining budget', () => {
    expect(() =>
      assertWithinCumulativeCap({ ...base, priorConsumedCents: 40_00, amountCents: 60_00 }),
    ).not.toThrow();
  });

  it('allows the exact remaining budget (boundary: prior + amount === total)', () => {
    expect(() =>
      assertWithinCumulativeCap({ ...base, priorConsumedCents: 70_00, amountCents: 30_00 }),
    ).not.toThrow();
  });

  it('REJECTS a memo that pushes the running total past the invoice (the M3 gap)', () => {
    // A prior $70 credit already applied; a new $40 would make $110 on a $100 invoice.
    let thrown: unknown;
    try {
      assertWithinCumulativeCap({ ...base, priorConsumedCents: 70_00, amountCents: 40_00 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CreditMemoValidationError);
    expect((thrown as CreditMemoValidationError).reason).toBe('cumulative_exceeds_invoice');
    expect((thrown as CreditMemoValidationError).status).toBe(422);
  });

  it('rejects even a 1¢ overflow (integer-cents, no rounding slack)', () => {
    expect(() =>
      assertWithinCumulativeCap({ ...base, priorConsumedCents: 99_99, amountCents: 2 }),
    ).toThrow(CreditMemoValidationError);
  });
});
