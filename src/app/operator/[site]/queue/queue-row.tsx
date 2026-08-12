'use client';

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { startLoadAction } from '../actions';

// Tap-to-start wrapper. Per CLAUDE.md hard rule #10 the queue row
// is a `<button>` with onClick rather than a form. The server action
// creates the InboundLoad and redirects to /load/[id], so on the happy
// path the client never sees a response.
//
// ── ADR-0096 — why this now has a catch ──────────────────────────────────────
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

export function QueueRow({
  siteCode,
  expectedLoadId,
  children,
}: {
  siteCode: string;
  expectedLoadId: string;
  children: React.ReactNode;
}) {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [staleDay, setStaleDay] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            try {
              await startLoadAction(siteCode, expectedLoadId);
            } catch (e) {
              if (
                e &&
                typeof e === 'object' &&
                'digest' in e &&
                typeof (e as { digest?: unknown }).digest === 'string' &&
                (e as { digest: string }).digest.startsWith('NEXT_REDIRECT')
              ) {
                throw e;
              }
              setStaleDay(true);
            }
          })
        }
        className="w-full rounded-lg bg-dr3-green-dark/40 p-4 text-left transition-colors hover:bg-dr3-green-dark/70 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {children}
      </button>

      {staleDay && (
        <div className="rounded-lg bg-dr3-green-dark/60 p-3">
          <p className="text-start text-sm font-semibold text-dr3-cream">
            {t('floor.hauls.stale_day')}
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
