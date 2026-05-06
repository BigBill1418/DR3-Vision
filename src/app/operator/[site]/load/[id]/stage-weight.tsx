'use client';

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { weightCapturedAction, weightSkipAction } from '../../actions';
import { PhotoInput } from './photo-input';

// Stage 2 — optional weight ticket. Two equal-weight buttons (Add /
// None) per SPRINT-1-PLAN. If Add: photo + integer-pounds numeric
// pad (1–100,000 valid range).

export function StageWeight({
  siteCode,
  loadId,
  onSkipped,
}: {
  siteCode: string;
  loadId: string;
  onSkipped: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'choose' | 'add'>('choose');
  const [hasPhoto, setHasPhoto] = useState(false);
  const [lbs, setLbs] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (mode === 'choose') {
    return (
      <section className="flex flex-col gap-6">
        <header>
          <h2 className="text-2xl font-bold">{t('stage_weight.heading')}</h2>
          <p className="text-sm text-dr3-cream/70">{t('stage_weight.subheading_choose')}</p>
        </header>
        <div className="grid grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => setMode('add')}
            className="rounded-lg bg-dr3-green px-6 py-8 text-xl font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark"
          >
            {t('stage_weight.add_weight')}
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                await weightSkipAction(siteCode, loadId);
                onSkipped();
              })
            }
            className="rounded-lg bg-dr3-green-dark/50 px-6 py-8 text-xl font-semibold text-dr3-cream transition-colors hover:bg-dr3-green-dark/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('stage_weight.none')}
          </button>
        </div>
      </section>
    );
  }

  const lbsNum = Number.parseInt(lbs, 10);
  const lbsValid = Number.isInteger(lbsNum) && lbsNum >= 1 && lbsNum <= 100_000;

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-2xl font-bold">{t('stage_weight.heading')}</h2>
        <p className="text-sm text-dr3-cream/70">{t('stage_weight.subheading_add')}</p>
      </header>
      <PhotoInput
        loadId={loadId}
        kind="weight_ticket"
        labelKey="weight_ticket"
        onCaptured={() => setHasPhoto(true)}
      />
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {t('stage_weight.weight_label')}
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={100_000}
          value={lbs}
          onChange={(e) => setLbs(e.target.value.replace(/\D/g, ''))}
          placeholder={t('stage_weight.weight_placeholder')}
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream placeholder:text-dr3-cream/40 focus:border-dr3-green focus:outline-none"
        />
      </label>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        type="button"
        disabled={!hasPhoto || !lbsValid || isPending}
        onClick={() =>
          startTransition(async () => {
            try {
              setError(null);
              await weightCapturedAction(siteCode, loadId, lbsNum);
            } catch (e) {
              setError(e instanceof Error ? e.message : t('stage_weight.save_failed'));
            }
          })
        }
        className="rounded-lg bg-dr3-chartreuse px-6 py-4 text-lg font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_weight.saving') : t('stage_weight.continue')}
      </button>
    </section>
  );
}
