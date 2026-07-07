// Rider 2 acceptance — the amendment error-message map covers every
// AmendmentRequestError reason code (no raw code ever surfaces) and falls back
// cleanly for an unknown/absent code.

import { describe, it, expect } from 'vitest';
import { amendmentErrorMessage, type AmendmentErrorCode } from '../amendment-error-messages';

// Must mirror AmendmentRequestError's `reason` union in amendment-requests.ts.
const ALL_CODES: AmendmentErrorCode[] = [
  'period_not_draft',
  'period_not_found',
  'employee_not_in_site',
  'justification_too_short',
  'invalid_count',
  'entry_not_found_for_update',
  'entry_exists_for_insert',
  'request_not_found',
  'request_not_pending',
  'not_eligible_to_approve',
  'reject_requires_notes',
  'cancel_only_by_requester',
  'empty_batch',
  'group_not_pending',
];

describe('amendmentErrorMessage', () => {
  it('maps every reason code to a non-empty, human sentence (no raw code)', () => {
    for (const code of ALL_CODES) {
      const msg = amendmentErrorMessage(code);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toBe(code); // never surfaces the raw code
      expect(msg).not.toMatch(/^[a-z_]+$/); // not a bare snake_case token
    }
  });

  it('period_not_draft explains the new 7:00 AM payroll-day close window', () => {
    expect(amendmentErrorMessage('period_not_draft')).toContain('7:00 AM');
  });

  it('falls back for an unknown or absent code', () => {
    expect(amendmentErrorMessage('totally_unknown_code')).toBe(
      'Something went wrong with this correction. Please try again.',
    );
    expect(amendmentErrorMessage(undefined)).toContain('Please try again');
    expect(amendmentErrorMessage(null, 'custom fallback')).toBe('custom fallback');
  });
});
