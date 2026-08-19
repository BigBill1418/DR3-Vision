'use client';

import type { RejectionCategory } from '@prisma/client';
import { useState, useTransition } from 'react';
import { useI18n } from '@/i18n/provider';
import { rejectLoadAction } from '../../actions';
import { useClaimLossGuard } from './use-claim-loss-guard';
import { PhotoInput } from './photo-input';
import { useLiveControl, type StageDisableReason } from './stage-liveness';
import { RejectFields, rejectFormReady, rejectNoteRequired } from './reject-fields';

// Stage 5b — reject. Category dropdown + multi-photo + note + submit.
// Photos are best-effort (T-007 wires R2); for T-006 the operator
// captures one rejection photo and the note carries the rest.
//
// ADR-0113 — the category list and the note rule moved to `reject-fields.tsx`.
// This stage is no longer the only place a load can be refused from
// (`late-reject-panel.tsx` offers the same decision from `in_progress` and
// `finished`), and a second hand-written copy of the `RejectionCategory` mirror
// is how a schema addition comes to render on one screen and not the other.

export function StageReject({
  siteCode,
  loadId,
  onCancel,
  /** ADR-0109 — rejection-evidence photos already on the server. */
  photoCount = 0,
}: {
  siteCode: string;
  loadId: string;
  onCancel: () => void;
  photoCount?: number;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<RejectionCategory | ''>('');
  const [hasPhoto, setHasPhoto] = useState(photoCount > 0);
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();
  // ADR-0082 — a stage refusal may be a takeover, and a Server Action's message
  // is redacted in production, so the client cannot read why. Asked, not guessed.
  const claimLost = useClaimLossGuard(siteCode, loadId);
  const [error, setError] = useState<string | null>(null);

  // ADR-0122 — Back is unconditional, so this stage always has one live control.
  // Registering Submit anyway is what makes the RECORD useful: the disable-reason
  // snapshot on a future `no_live_controls` elsewhere is only readable if the
  // vocabulary is consistent across stages.
  // ADR-0113 — `no_note` is the fourth refusal, and it is a vocabulary entry
  // rather than an extra `||` on the button. `submitReason` is BOTH what
  // disables the control and what ADR-0122 reports when a screen goes dead; a
  // `disabled` that could be true while `submitReason` was null would make that
  // snapshot a record of a different screen than the one the operator is stuck
  // on — which is the whole failure this instrument exists to catch.
  //
  // The order is the operator's order: they pick a reason, photograph it, and
  // type only if the reason was `other`.
  const submitReason: StageDisableReason | null = isPending
    ? 'pending'
    : !category
      ? 'no_category'
      : !hasPhoto
        ? 'no_photo'
        : rejectNoteRequired(category) && !note.trim()
          ? 'no_note'
          : null;
  useLiveControl('reject_back', null);
  useLiveControl('reject_submit', submitReason);

  const submit = () => {
    // ADR-0113 — mirrors the server's two 422s (`rejection_photo_required`,
    // `rejection_note_required`), which are now enforced there rather than
    // living only in this button's `disabled`.
    // `category === ''` first so the narrowing reaches the action call below;
    // `rejectFormReady` re-checks it, but a helper returning true is not a type
    // guard over one of its inputs.
    if (category === '') return;
    if (!rejectFormReady({ category, note, hasPhoto })) return;
    if (rejectNoteRequired(category) && !note.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        await rejectLoadAction(siteCode, loadId, category, note.trim() || null);
      } catch (e) {
        // The claim may have moved while this iPad sat on the stage screen.
        // Refresh in that case: the page re-renders as the held-by panel and
        // NAMES the new holder, instead of a redacted server message.
        if (await claimLost()) return;
        setError(e instanceof Error ? e.message : t('stage_reject.reject_failed'));
      }
    });
  };

  return (
    <section className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-2xl font-bold">{t('stage_reject.heading')}</h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-dr3-cream/70 underline-offset-2 hover:underline"
        >
          {t('stage_reject.back')}
        </button>
      </header>
      <RejectFields
        category={category}
        onCategory={setCategory}
        note={note}
        onNote={setNote}
        idPrefix="stage-reject"
      />
      <PhotoInput
        loadId={loadId}
        kind="rejection"
        labelKey="rejection"
        onCaptured={() => setHasPhoto(true)}
        initialCount={photoCount}
      />
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        type="button"
        data-testid="stage-reject-submit"
        disabled={submitReason !== null}
        onClick={submit}
        className="rounded-lg bg-red-700 px-6 py-4 text-lg font-semibold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_reject.rejecting') : t('stage_reject.submit')}
      </button>
    </section>
  );
}
