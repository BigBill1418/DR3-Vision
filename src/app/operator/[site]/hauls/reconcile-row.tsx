'use client';

// ADR-0096 — the control for a truck that arrived on a day other than its slot's.
//
// ## Why this is deliberately NOT the ordinary check-in button
//
// `QueueRow` is one big tap target, because for a truck that is due today the
// only sane thing to do is start it. This state is different: the slot the
// operator is about to consume is booked for ANOTHER DAY, and consuming the
// wrong one is the 159-unit mis-booking ADR-0074 Am.1 was written about. So the
// affordance is two taps, and the second one reads back the two facts that
// identify the slot — the haul number and the day it was booked for.
//
// That is friction on purpose, and it is the same friction the server enforces:
// the confirmed day travels to `startLoadReconciledAction`, and
// `startInboundLoad` refuses unless it matches the row. The UI is where the
// operator READS the day; the server is where the day is CHECKED. Neither alone
// would be enough — the read layer's day bound was UI-only until ADR-0096, which
// is exactly how a bookmarked page could go around it.
//
// ## Why a two-tap disclosure and not `window.confirm`
//
// `window.confirm`/`window.prompt` are unstyled, unlocalised, and on iPadOS they
// are dismissible in ways that give no signal back (the floor dead-end audit's
// D-20 records a live case of exactly that). This expands in place, in the
// operator's own language, with both controls at the ADR-0060 gloved-hand size.
//
// ## Failure is SHOWN, not swallowed
//
// The server can legitimately refuse this (someone else claimed the slot in the
// meantime; MyMRC re-synced the appointment out from under the page). Audit
// finding D-8 is precisely the class where a refused floor write renders nothing
// and the operator retaps forever, so the catch here renders a sentence and
// leaves the control usable.

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { isNextRedirectSignal } from '@/lib/next-redirect';
import { startLoadReconciledAction } from '../actions';

export function ReconcileRow({
  siteCode,
  expectedLoadId,
  slotDayISO,
  slotDayLabel,
  haulLabel,
  children,
}: {
  siteCode: string;
  expectedLoadId: string;
  /** The slot's own Pacific day. Sent verbatim; the server compares it. */
  slotDayISO: string;
  /** The same day, formatted for a human to read before confirming. */
  slotDayLabel: string;
  haulLabel: string;
  children: React.ReactNode;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="rounded-lg bg-dr3-green-dark/40 p-4">
      {children}
      <p className="mt-2 text-start text-xs font-bold uppercase tracking-wide text-dr3-cream/70">
        {t('floor.hauls.late_scheduled', { date: slotDayLabel })}
      </p>

      {!confirming ? (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setConfirming(true);
          }}
          className="mt-3 min-h-[56px] w-full rounded-lg bg-dr3-green px-4 py-3 text-base font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream active:bg-dr3-green-dark"
        >
          {t('floor.hauls.late_cta')}
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {/* The read-back. Naming the haul AND the booked day is what makes the
              next tap a decision rather than a reflex. */}
          <p className="text-start text-sm font-medium text-dr3-cream">
            {t('floor.hauls.late_confirm', { haul: haulLabel, date: slotDayLabel })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    // ADR-0127 — the haul number this panel already reads back
                    // now travels with the day and is checked the same way.
                    await startLoadReconciledAction(
                      siteCode,
                      expectedLoadId,
                      slotDayISO,
                      haulLabel,
                    );
                  } catch (e) {
                    // A server action's `redirect()` throws a control-flow signal
                    // that MUST be re-thrown, or a successful check-in would be
                    // reported to the operator as a failure — the inverse of D-8
                    // and just as bad.
                    // ADR-0127 — the shared predicate; see `next-redirect.ts`.
                    if (isNextRedirectSignal(e)) throw e;
                    setFailed(true);
                    setConfirming(false);
                  }
                })
              }
              className="min-h-[56px] flex-1 rounded-lg bg-dr3-green px-4 py-3 text-base font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('floor.hauls.late_yes')}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setConfirming(false)}
              className="min-h-[56px] rounded-lg px-4 py-3 text-base font-semibold text-dr3-cream/80 underline underline-offset-4 disabled:opacity-60"
            >
              {t('floor.hauls.late_cancel')}
            </button>
          </div>
        </div>
      )}

      {failed && (
        <p className="mt-2 text-start text-sm font-semibold text-dr3-cream">
          {t('floor.hauls.late_failed')}
        </p>
      )}
    </div>
  );
}
