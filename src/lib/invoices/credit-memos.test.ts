// 2026-07-09 rollup §1.4 — the credit-memo state machine, pure parts.
// (DB orchestration is exercised at the route level; the machine itself —
// which jumps are legal — is the money-critical invariant and tests pure.)

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  CreditMemoTransitionError,
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
