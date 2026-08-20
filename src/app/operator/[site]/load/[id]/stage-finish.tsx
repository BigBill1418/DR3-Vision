'use client';

import type { ConcernCategory } from '@prisma/client';
import { useState, useTransition } from 'react';
import { useI18n } from '@/i18n/provider';
import { newIdempotencyKey } from '@/lib/offline-queue';
import { addConcernAction, submitLoadAction } from '../../actions';
import { useClaimLossGuard } from './use-claim-loss-guard';
import { useLiveControl } from './stage-liveness';

const CONCERN_CATEGORIES: ConcernCategory[] = [
  'damaged',
  'wet',
  'bedbugs',
  'contamination',
  'short',
  'mislabeled',
  'other',
];

// Stage 6/7 — Finish + optional concern + Submit. Submit signs the
// operator out (per ADR-0004 auto-logout on every load submission)
// and routes back to the name picker.

type Props = {
  siteCode: string;
  loadId: string;
  operatorName: string;
  totalUnits: number | null;
};

export function StageFinish({ siteCode, loadId, operatorName, totalUnits }: Props) {
  const { t, locale } = useI18n();
  const [showConcern, setShowConcern] = useState(false);
  const [concernSaved, setConcernSaved] = useState(false);
  const [category, setCategory] = useState<ConcernCategory | ''>('');
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();
  // ADR-0082 — a stage refusal may be a takeover, and a Server Action's message
  // is redacted in production, so the client cannot read why. Asked, not guessed.
  const claimLost = useClaimLossGuard(siteCode, loadId);
  const [error, setError] = useState<string | null>(null);

  // ADR-0122 — Submit is gated only by `isPending`, so this stage is safe by the
  // same accident stage 4 is. Registered so the detector's denominator is the
  // whole screen rather than the controls somebody remembered.
  useLiveControl('finish_add_concern', showConcern ? 'not_rendered' : null);
  useLiveControl('finish_concern_cancel', showConcern ? null : 'not_rendered');
  useLiveControl(
    'finish_concern_save',
    !showConcern ? 'not_rendered' : isPending ? 'pending' : !category ? 'no_category' : null,
  );
  useLiveControl('finish_submit', isPending ? 'pending' : null);

  const saveConcern = () => {
    if (!category) return;
    setError(null);
    startTransition(async () => {
      try {
        // ADR-0078 — a concern has no natural key, so an unkeyed retry after a
        // dropped response would file the same concern twice against the load.
        await addConcernAction(
          newIdempotencyKey(),
          siteCode,
          loadId,
          category,
          note.trim() || null,
        );
        setConcernSaved(true);
        setShowConcern(false);
        // Audit D-24 — the form is now re-openable, so it must not re-open
        // pre-filled with the concern just filed. `addConcernAction` mints a
        // fresh idempotency key per call, so a re-submit of identical text would
        // file a genuine SECOND row rather than being deduped — the reset is
        // what stops "add another" from meaning "accidentally file that again".
        setCategory('');
        setNote('');
      } catch (e) {
        // The claim may have moved while this iPad sat on the stage screen.
        // Refresh in that case: the page re-renders as the held-by panel and
        // NAMES the new holder, instead of a redacted server message.
        if (await claimLost()) return;
        setError(e instanceof Error ? e.message : t('stage_finish.save_failed'));
      }
    });
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        await submitLoadAction(siteCode, loadId);
      } catch (e) {
        // The claim may have moved while this iPad sat on the stage screen.
        // Refresh in that case: the page re-renders as the held-by panel and
        // NAMES the new holder, instead of a redacted server message.
        if (await claimLost()) return;
        setError(e instanceof Error ? e.message : t('stage_finish.submit_failed'));
      }
    });
  };

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-2xl font-bold">{t('stage_finish.heading')}</h2>
        <p className="text-sm text-dr3-cream/70">
          {t('stage_finish.operator_units_caption', { name: operatorName, units: totalUnits ?? 0 })}
        </p>
      </header>

      {/* Audit D-24 — this used to require `!concernSaved`, so after saving ONE
          concern the control was simply GONE, with no sentence explaining why.
          An operator with a second thing to report (a load can easily have both
          contamination and a damaged pallet) had no affordance and nothing
          telling them the screen had decided one was enough. Nothing server-side
          limits concerns to one per load — the restriction existed only in this
          boolean. The label changes on the second pass so the control reads as
          "another", not as an undo of the one already recorded. */}
      {!showConcern && (
        <button
          type="button"
          onClick={() => setShowConcern(true)}
          data-testid="add-concern"
          className="rounded-lg bg-dr3-green-dark/50 px-6 py-4 text-base font-semibold text-dr3-cream transition-colors hover:bg-dr3-green-dark/80"
        >
          {concernSaved ? t('stage_finish.concern_add_another') : t('stage_finish.add_concern')}
        </button>
      )}

      {showConcern && (
        <div className="flex flex-col gap-3 rounded-lg bg-dr3-green-dark/40 p-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
            {t('stage_finish.concern_type_label')}
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ConcernCategory | '')}
              className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
            >
              <option value="">{t('stage_finish.concern_type_select')}</option>
              {CONCERN_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`stage_finish.concern_category_${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
            {t('stage_finish.note_label')}
            {/* `lang={locale}` so iPadOS dictation picks the right input
                language for voice-to-text per SPRINT-1-PLAN T-008. */}
            <textarea
              rows={3}
              lang={locale}
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 1000))}
              placeholder={t('stage_finish.note_placeholder')}
              className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
            />
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setShowConcern(false)}
              className="flex-1 rounded-md bg-dr3-green-dark/50 px-4 py-2 text-sm font-semibold text-dr3-cream"
            >
              {t('stage_finish.cancel')}
            </button>
            <button
              type="button"
              disabled={!category || isPending}
              onClick={saveConcern}
              className="flex-1 rounded-md bg-dr3-green px-4 py-2 text-sm font-semibold text-dr3-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('stage_finish.save_concern')}
            </button>
          </div>
        </div>
      )}

      {concernSaved && (
        <p className="rounded-md bg-dr3-green-dark/40 px-4 py-2 text-sm text-dr3-cream/80">
          {t('stage_finish.concern_recorded')}
        </p>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      <button
        type="button"
        disabled={isPending}
        onClick={submit}
        className="rounded-lg bg-dr3-chartreuse px-6 py-6 text-xl font-bold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_finish.submitting') : t('stage_finish.submit')}
      </button>
    </section>
  );
}
