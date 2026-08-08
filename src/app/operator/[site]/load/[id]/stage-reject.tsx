'use client';

import type { RejectionCategory } from '@prisma/client';
import { useState, useTransition } from 'react';
import { useI18n } from '@/i18n/provider';
import { rejectLoadAction } from '../../actions';
import { useClaimLossGuard } from './use-claim-loss-guard';
import { PhotoInput } from './photo-input';

const CATEGORIES: RejectionCategory[] = [
  'contamination',
  'damaged',
  'wet',
  'bedbugs',
  'short',
  'mislabeled',
  'other',
];

// Stage 5b — reject. Category dropdown + multi-photo + note + submit.
// Photos are best-effort (T-007 wires R2); for T-006 the operator
// captures one rejection photo and the note carries the rest.

export function StageReject({
  siteCode,
  loadId,
  onCancel,
}: {
  siteCode: string;
  loadId: string;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const [category, setCategory] = useState<RejectionCategory | ''>('');
  const [hasPhoto, setHasPhoto] = useState(false);
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();
  // ADR-0082 — a stage refusal may be a takeover, and a Server Action's message
  // is redacted in production, so the client cannot read why. Asked, not guessed.
  const claimLost = useClaimLossGuard(siteCode, loadId);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!category || !hasPhoto) return;
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
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {t('stage_reject.reason_label')}
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as RejectionCategory | '')}
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-3 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
        >
          <option value="">{t('stage_reject.reason_select')}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`stage_reject.category_${c}`)}
            </option>
          ))}
        </select>
      </label>
      <PhotoInput
        loadId={loadId}
        kind="rejection"
        labelKey="rejection"
        onCaptured={() => setHasPhoto(true)}
      />
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {t('stage_reject.note_label')}
        {/* `lang={locale}` so iPadOS dictation picks the right input
            language for voice-to-text per SPRINT-1-PLAN T-008. */}
        <textarea
          rows={4}
          lang={locale}
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 1000))}
          placeholder={t('stage_reject.note_placeholder')}
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream placeholder:text-dr3-cream/40 focus:border-dr3-green focus:outline-none"
        />
      </label>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        type="button"
        disabled={isPending || !category || !hasPhoto}
        onClick={submit}
        className="rounded-lg bg-red-700 px-6 py-4 text-lg font-semibold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_reject.rejecting') : t('stage_reject.submit')}
      </button>
    </section>
  );
}
