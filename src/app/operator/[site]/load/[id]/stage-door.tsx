'use client';

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { doorOpenCapturedAction } from '../../actions';
import { PhotoInput } from './photo-input';
import { useLiveControl, type StageDisableReason } from './stage-liveness';

// Stage 3 — forced door-open photo. Per ADR-0012 §1, the visible
// timer starts on submission of THIS photo (not BOL). The server
// stamps `unload_started_at` and computes
// `time_to_unload_start_seconds` (silent SLA metric).

export function StageDoor({
  siteCode,
  loadId,
  /** ADR-0109 — door-open photos already on the server. */
  photoCount = 0,
}: {
  siteCode: string;
  loadId: string;
  photoCount?: number;
}) {
  const t = useT();
  const [hasFile, setHasFile] = useState(false);
  const [isPending, startTransition] = useTransition();

  // ADR-0122 — see `stage-bol.tsx`. Truth-equivalent to the `(!hasFile &&
  // photoCount === 0) || isPending` that shipped in #286.
  const continueReason: StageDisableReason | null = isPending
    ? 'pending'
    : !hasFile && photoCount === 0
      ? 'no_photo'
      : null;
  useLiveControl('door_continue', continueReason);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-2xl font-bold">{t('stage_door.heading')}</h2>
        <p className="text-sm text-dr3-cream/70">{t('stage_door.subheading')}</p>
      </header>
      <PhotoInput
        loadId={loadId}
        kind="door_open"
        labelKey="door_open"
        onCaptured={() => setHasFile(true)}
        initialCount={photoCount}
      />
      {/* ADR-0121 — same gate as `stage-bol.tsx`, and armed for the same reason.
          This stage was not the one that trapped the floor on 2026-08-20 only
          because `stage-stacks` had not been reached yet; the shape is
          identical. A door-open photo does not move `load.status` off
          `unload_started` on its own, so a reload or a takeover returns here
          with the photo on the server and `hasFile` false — capture disabled,
          "add another" absent, and this button dead. Fixed in the same change
          rather than left to be rediscovered by an operator standing at a
          truck. (Stage 2, weight, escapes via its own "None" button.) */}
      <button
        type="button"
        disabled={continueReason !== null}
        onClick={() =>
          startTransition(async () => {
            await doorOpenCapturedAction(siteCode, loadId);
          })
        }
        className="rounded-lg bg-dr3-chartreuse px-6 py-4 text-lg font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_door.starting_timer') : t('stage_door.start_unload')}
      </button>
    </section>
  );
}
