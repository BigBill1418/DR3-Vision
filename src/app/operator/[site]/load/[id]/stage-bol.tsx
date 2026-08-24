'use client';

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { bolCapturedAction } from '../../actions';
import { PhotoInput } from './photo-input';
import { useLiveControl, type StageDisableReason } from './stage-liveness';

// Stage 1 — forced BOL photo. Per SPRINT-1-PLAN: "Forced BOL photo
// (timer does not start)". The Continue button stays disabled until
// the camera input fires `onCaptured` with a file handle.

export function StageBol({
  siteCode,
  loadId,
  // ADR-0109 / ADR-0124 — BOL photos already on the server. Load-bearing twice
  // over on THIS stage: it arms Continue on a re-entry (ADR-0121), and it is now
  // the fact that decides whether this stage renders AT ALL. The `onCaptured`
  // callback is gone with the `bolDone` latch it used to set.
  photoCount = 0,
}: {
  siteCode: string;
  loadId: string;
  photoCount?: number;
}) {
  const t = useT();
  const [hasFile, setHasFile] = useState(false);
  const [isPending, startTransition] = useTransition();

  // ADR-0122 — ONE expression, read by both the button and the detector. Written
  // as a reason chain rather than a boolean so a screen that is merely BUSY
  // (`pending`) is never mistaken for one that is trapped; truth-equivalent to
  // the `(!hasFile && photoCount === 0) || isPending` that shipped in #286.
  const continueReason: StageDisableReason | null = isPending
    ? 'pending'
    : !hasFile && photoCount === 0
      ? 'no_photo'
      : null;
  useLiveControl('bol_continue', continueReason);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-2xl font-bold">{t('stage_bol.heading')}</h2>
        <p className="text-sm text-dr3-cream/70">{t('stage_bol.subheading')}</p>
      </header>
      <PhotoInput
        loadId={loadId}
        kind="bol"
        labelKey="bol"
        onCaptured={() => setHasFile(true)}
        initialCount={photoCount}
      />
      {/* ADR-0121 — the gate reads the SERVER FACT as well as this mount's state.
          `hasFile` is `useState(false)` and is therefore false on every fresh
          mount, no matter what the load already holds. Taking the BOL does not
          move `load.status` (it stays `arrived`), so a reload — or the next
          operator taking the load over — comes back to this stage with the photo
          already written and `hasFile` false. Combined with `PhotoInput`
          disabling capture once `count > 0` and withholding "add another" until
          `done`/`queued`, that left the screen with NO live control at all, and
          it survived a hard refresh because the trapping state is a
          `load_photos` row. H-137810 sat at `arrived` for 90+ minutes on
          2026-08-20 while three operators took it over in turn.

          `photoCount === 0` keeps ADR-0060's forced-BOL rule intact: a first
          visit with nothing captured and nothing on the server still refuses. */}
      <button
        type="button"
        disabled={continueReason !== null}
        // ADR-0124 — no client callback. The action revalidates this route, the
        // page re-reads `photo_counts.bol`, and `selectStage` moves the operator
        // on. If that revalidation is ever missed, the failure mode is a LIVE
        // Continue button they can tap again — not a dead screen. That asymmetry
        // is the whole reason to prefer the server fact: the worst case is a
        // retry, and ADR-0122's detector would page if it ever were not.
        onClick={() =>
          startTransition(async () => {
            await bolCapturedAction(siteCode, loadId);
          })
        }
        className="rounded-lg bg-dr3-chartreuse px-6 py-4 text-lg font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_bol.saving') : t('stage_bol.continue')}
      </button>
    </section>
  );
}
