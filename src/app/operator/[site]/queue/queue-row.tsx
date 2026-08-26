'use client';

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { isNextRedirectSignal } from '@/lib/next-redirect';
import { startLoadAction } from '../actions';

// Tap-to-start wrapper. Per CLAUDE.md hard rule #10 the queue row
// is a `<button>` with onClick rather than a form. The server action
// creates the InboundLoad and redirects to /load/[id], so on the happy
// path the client never sees a response.
//
// ── ADR-0096 — why this has a catch ──────────────────────────────────────────
//
// It used to be `await startLoadAction(...)` with nothing around it. That was
// survivable only because the action could not really refuse: the day bound
// lived in the READ layer, so any row that rendered a button was startable by
// construction. ADR-0096 moved the bound server-side, which is the correct place
// for it — and in doing so created a refusal this component could receive.
//
// An unhandled throw here is the exact shape of the floor dead-end audit's D-8:
// the tap does nothing, no sentence appears, and the operator taps again. So the
// one refusal that a correctly-rendered page can still hit — the page was
// rendered before Pacific midnight and tapped after it, when the slot is no
// longer today's — gets named, with the reload that actually fixes it.
//
// `NEXT_REDIRECT` MUST be re-thrown. A successful check-in reaches this catch as
// a thrown control-flow signal, and swallowing it would report every success as
// a failure — the inverse of the defect, and worse.
//
// ── ADR-0127 — WHY THIS IS NOW TWO TAPS ──────────────────────────────────────
//
// On 2026-08-25 the 9:30 AM Woodland truck — Lake County Waste Solutions haul
// H-138155, carried by Ron Lawrence & Son — was worked start to finish on the
// RECOLOGY MOUNTAIN VIEW card H-138504. Different supplier, different carrier,
// 55 minutes of unloading, 135 units, submitted. Nothing between the tap and the
// submit ever asked "is this the right truck?".
//
// ADR-0090 D1 put the haul number on this card for exactly this reason and it
// was not enough, because a chip you are not asked about is a chip you do not
// read. The supplier and the carrier were on the card too. The defect is not
// that the identifying facts were absent — it is that ONE TAP committed to them.
//
// So the identity is now read back and confirmed, in the ADR-0096 `ReconcileRow`
// idiom this repo already established for the other consume-the-wrong-slot case:
// an in-place disclosure, not `window.confirm` (unstyled, unlocalised, and
// dismissible on iPadOS in ways that give no signal back — floor dead-end audit
// D-20), both controls at the ADR-0060 gloved-hand 56px, every offset logical so
// the Urdu RTL build mirrors rather than shears.
//
// The confirmed haul number TRAVELS: `startInboundLoad` compares it against the
// slot inside the writing transaction. The UI is where the operator READS the
// identity; the server is where it is CHECKED. Neither alone would be enough —
// a read-back nobody verifies is a decoration, and a server check nobody was
// shown is a refusal out of nowhere.

export function QueueRow({
  siteCode,
  expectedLoadId,
  /** The slot's haul number, exactly as the card renders it. Travels on confirm. */
  haulLabel,
  /** Who sent the mattresses — the collection site / supplier. */
  sourceLabel,
  /** Who is driving them. The field that separated the two 2026-08-25 cards. */
  transporterLabel,
  children,
}: {
  siteCode: string;
  expectedLoadId: string;
  haulLabel: string;
  sourceLabel: string;
  transporterLabel: string;
  children: React.ReactNode;
}) {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          setRefused(false);
          setConfirming(true);
        }}
        className="w-full rounded-lg bg-dr3-green-dark/40 p-4 text-left transition-colors hover:bg-dr3-green-dark/70 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {children}
      </button>

      {confirming && (
        <div
          className="flex flex-col gap-2 rounded-lg bg-dr3-green-dark/60 p-4"
          data-testid="queue-row-confirm"
        >
          {/* The read-back. Three facts, on three lines, at a size that is read
              rather than glanced past — the haul number the office knows the
              truck by, the supplier who sent it, and the carrier who drove it.
              The carrier is the line that separated H-138155 from H-138504 and
              it is deliberately not the dimmest thing on the panel. */}
          <p className="text-start text-sm font-semibold text-dr3-cream/80">
            {t('floor.confirm_checkin.question')}
          </p>
          <p className="text-start font-mono text-2xl font-bold tabular-nums text-dr3-cream">
            {haulLabel}
          </p>
          <p className="text-start text-lg font-semibold text-dr3-cream">{sourceLabel}</p>
          <p className="text-start text-base font-medium text-dr3-cream/90">
            {t('floor.confirm_checkin.carrier', { name: transporterLabel })}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    await startLoadAction(siteCode, expectedLoadId, haulLabel);
                  } catch (e) {
                    // ADR-0127 — the shared predicate; see `next-redirect.ts`.
                    if (isNextRedirectSignal(e)) throw e;
                    setConfirming(false);
                    setRefused(true);
                  }
                })
              }
              className="min-h-[56px] flex-1 rounded-lg bg-dr3-green px-4 py-3 text-base font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('floor.confirm_checkin.yes')}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setConfirming(false)}
              className="min-h-[56px] rounded-lg px-4 py-3 text-base font-semibold text-dr3-cream/80 underline underline-offset-4 disabled:opacity-60"
            >
              {t('floor.confirm_checkin.no')}
            </button>
          </div>
        </div>
      )}

      {refused && (
        <div className="rounded-lg bg-dr3-green-dark/60 p-3">
          <p className="text-start text-sm font-semibold text-dr3-cream">
            {t('floor.confirm_checkin.mismatch')}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 min-h-[44px] rounded-lg bg-dr3-green px-4 py-2 text-sm font-bold text-dr3-ink"
          >
            {t('update_prompt.reload')}
          </button>
        </div>
      )}
    </div>
  );
}
