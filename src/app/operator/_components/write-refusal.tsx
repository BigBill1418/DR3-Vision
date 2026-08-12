'use client';

import { useT } from '@/i18n/provider';

// Audit D-8 — the two refusals every floor WRITE client can earn and none of
// them could read.
//
// ## Why this is one module and not four copies
//
// `/inbound`, `/count`, `/processed` and `/dropoff` are four separate screens
// that all POST to a route guarded by the same two gates: the ADR-0065
// current-Pacific-day pin (`assertCurrentPacificDay` → 422 `date_not_today`)
// and the session check (`requireActivatedOperator` → 401). Each client had its
// own private `if (b.error === …)` ladder, and the two gates that fire on EVERY
// screen were in none of them: all four fell through to
// `floor.common.save_failed` — "Couldn't save. Try again." — which for these two
// causes is an instruction to do the one thing that cannot work.
//
// The classification therefore lives at one chokepoint, so a fifth write screen
// inherits it instead of re-earning the defect.
//
// ## Nothing here is new copy
//
// Both sentences and the control label already shipped, in all three locales:
//
//   `floor.conflicts.why_wrong_day`      — written for the OFFLINE replay of the
//     same 422 (`conflicts-client.tsx:168`). The refusal is identical whether the
//     write was live or drained; only the path differed.
//   `auth_login.error_session_expired`   — the sentence that names the condition
//     AND the action. `photo-input.tsx` classifies 401 the same way; its own
//     caption is not reused here because it ends "…and this photo sends by
//     itself", which is true of a queued blob and false of a count that was
//     refused outright. A confirmation the system will not honour is the defect,
//     not the fix.
//   `update_prompt.reload`               — the app shell's own label for "the
//     page you are looking at has gone out of date". See `WriteRefusalNotice`
//     below for why that, and not `floor.conflicts.resubmit_today`.

export type WriteRefusal = 'wrong_day' | 'signed_out';

/**
 * Classify a non-ok floor write response.
 *
 * `status` first: a 401 is answered by `auth-helpers` with a bare
 * `new Response('unauthenticated', { status: 401 })`, whose empty `statusText`
 * `loadsErrorResponse` renders as `{ error: 'error' }` — so the body carries no
 * usable reason and the STATUS is the only honest signal. This mirrors
 * `isSignedOut` in `photo-input.tsx`, deliberately including its exclusion of
 * 403: authenticated-but-refused is not fixed by signing in again.
 *
 * `date_not_today` rides in the body because `assertCurrentPacificDay` throws
 * `new Response(null, { status: 422, statusText: 'date_not_today' })` and
 * `loadsErrorResponse` copies `statusText` into `{ error }`.
 *
 * Returns `null` for everything else, so each client keeps its own reason map
 * (`pool_mismatch`, `office_owned`, `closed`, …) untouched.
 */
export function classifyWriteRefusal(status: number, errorCode: unknown): WriteRefusal | null {
  if (status === 401) return 'signed_out';
  if (errorCode === 'date_not_today') return 'wrong_day';
  return null;
}

/**
 * The refusal, and — for the day mismatch — the way out.
 *
 * ## Why the control is a reload and not a "re-submit to today"
 *
 * The conflicts screen offers `floor.conflicts.resubmit_today` because it holds
 * a STORED entry it can re-address, and it is handed `todayISO` by its server
 * page. Neither is true here: the entry only exists in the fields on screen, and
 * the day this page was rendered with is precisely the stale value being
 * refused. The client cannot name today — reading it off the iPad's own clock is
 * the mistake `dropoff-client.tsx` and `count-client.tsx` both carry an explicit
 * comment against, and D-23 is the standing finding for surfaces that did.
 *
 * So the honest control is the one the app shell already uses when the page a
 * person is looking at has gone out of date: reload, and let the SERVER say what
 * day it is. `onRefresh` is wired to `router.refresh()` rather than
 * `window.location.reload()` because a soft refresh re-renders the server
 * component — the day prop updates — while leaving the numbers the operator
 * already typed in place. Making somebody re-key a floor count to clear a
 * banner is how a guardrail teaches people to rush past it.
 */
export function WriteRefusalNotice({
  refusal,
  onRefresh,
}: {
  refusal: WriteRefusal;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3" data-testid="write-refusal" data-refusal={refusal}>
      <p role="alert" className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white">
        {refusal === 'wrong_day'
          ? t('floor.conflicts.why_wrong_day')
          : t('auth_login.error_session_expired')}
      </p>
      {refusal === 'wrong_day' && (
        <button
          type="button"
          onClick={onRefresh}
          data-testid="write-refusal-refresh"
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink"
        >
          {t('update_prompt.reload')}
        </button>
      )}
    </div>
  );
}
