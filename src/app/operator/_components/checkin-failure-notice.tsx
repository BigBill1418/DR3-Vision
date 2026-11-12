'use client';

import { useT } from '@/i18n/provider';
import type { FloorActionFailure } from '@/lib/floor/action-outcome';
import { FloorSignInLink } from './floor-sign-in-link';

const COPY: Record<FloorActionFailure, string> = {
  signed_out: 'floor.action_outcome.signed_out',
  // The ONLY failure that says the card changed — a real 409 from the read-back
  // or the day guard. ADR-0144: on 2026-11-10 this copy was shown for a 401.
  card_changed: 'floor.confirm_checkin.mismatch',
  not_allowed: 'floor.action_outcome.not_allowed',
  app_updated: 'floor.action_outcome.app_updated',
  no_connection: 'floor.action_outcome.no_connection',
  failed: 'floor.action_outcome.failed',
};

/**
 * ADR-0144 — the sentence for a failed check-in, and the control that fixes it.
 *
 * Shared by `QueueRow` and `ReconcileRow` so the two check-in surfaces cannot
 * drift apart on what a failure means. The control follows the cause: sign-in
 * for a lapsed session; a reload when the page itself is stale (card changed, app
 * updated, unknown); nothing for "no connection" (a reload would fail too — the
 * card stays tappable to retry) or "not allowed" (no tap on this iPad fixes it).
 */
export function CheckinFailureNotice({
  failure,
  siteCode,
}: {
  failure: FloorActionFailure;
  siteCode: string;
}) {
  const t = useT();
  const reloads = failure === 'card_changed' || failure === 'app_updated' || failure === 'failed';
  return (
    <div
      className="flex flex-col gap-2 rounded-lg bg-dr3-green-dark/60 p-3"
      data-testid="checkin-failure"
      data-failure={failure}
    >
      <p role="alert" className="text-start text-sm font-semibold text-dr3-cream">
        {t(COPY[failure])}
      </p>
      {failure === 'signed_out' && <FloorSignInLink siteCode={siteCode} testId="checkin-sign-in" />}
      {reloads && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-2 text-sm font-bold text-dr3-ink"
        >
          {t('update_prompt.reload')}
        </button>
      )}
    </div>
  );
}
