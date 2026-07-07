// ADR-0028/0029 + ADR-0019.1 (2026-07-07 amendment) — plain-English messages for
// the AmendmentRequestError reason codes the amendment API returns, so the UI
// (request creation + approve/reject surfaces) never shows a raw code like
// `period_not_draft`. Manager/admin office surfaces are English-first (ADR-0017).
//
// Keep this in sync with AmendmentRequestError's `reason` union in
// src/lib/bonus/amendment-requests.ts.

export type AmendmentErrorCode =
  | 'period_not_draft'
  | 'period_not_found'
  | 'employee_not_in_site'
  | 'justification_too_short'
  | 'invalid_count'
  | 'entry_not_found_for_update'
  | 'entry_exists_for_insert'
  | 'request_not_found'
  | 'request_not_pending'
  | 'not_eligible_to_approve'
  | 'reject_requires_notes'
  | 'cancel_only_by_requester'
  | 'empty_batch'
  | 'group_not_pending';

const MESSAGES: Record<AmendmentErrorCode, string> = {
  // The close now runs at 7:00 AM on payroll day (ADR-0019.1 amendment), so the
  // signature window is the reference point for when corrections can still land.
  period_not_draft:
    'This pay period has closed for signatures — corrections can be approved until 7:00 AM on payroll day; after that, contact Bill (admin path).',
  period_not_found: 'That pay period could not be found. Refresh the page and try again.',
  employee_not_in_site: 'That employee is not on this site’s roster for this pay period.',
  justification_too_short:
    'Add a longer justification (at least 20 characters) explaining why this correction is needed.',
  invalid_count: 'Enter a whole mattress count from 0 to 999.',
  entry_not_found_for_update:
    'There is no existing entry to update for that day — choose “add a new entry” instead.',
  entry_exists_for_insert:
    'An entry already exists for that day — edit the existing one instead of adding a new entry.',
  request_not_found: 'That correction request could not be found — it may have already been handled.',
  request_not_pending:
    'That correction request has already been decided (approved, rejected, or cancelled).',
  not_eligible_to_approve:
    'You are not authorized to approve corrections. Approving amendments is an admin action.',
  reject_requires_notes: 'Add a note explaining why you are rejecting this correction.',
  cancel_only_by_requester: 'Only the person who requested this correction can cancel it.',
  empty_batch: 'Add at least one corrected count before submitting.',
  group_not_pending: 'This batch of corrections has already been decided — there is nothing left to act on.',
};

const DEFAULT_FALLBACK = 'Something went wrong with this correction. Please try again.';

/**
 * Map an AmendmentRequestError reason code (as returned in an API `{ error }`
 * body) to a human-readable sentence. An unknown/absent code returns `fallback`.
 */
export function amendmentErrorMessage(
  code: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) {
    return MESSAGES[code as AmendmentErrorCode];
  }
  return fallback;
}
