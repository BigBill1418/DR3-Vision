'use client';

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { weightCapturedAction, weightSkipAction } from '../../actions';
import { useClaimLossGuard } from './use-claim-loss-guard';
import { PhotoInput } from './photo-input';
import { useLiveControl, type StageDisableReason } from './stage-liveness';

// Stage 2 — optional weight ticket. Two equal-weight buttons (Add /
// None) per SPRINT-1-PLAN. If Add: photo + integer-pounds numeric
// pad (1–100,000 valid range).

export function StageWeight({
  siteCode,
  loadId,
  onSkipped,
  /** ADR-0109 — weight-ticket photos already on the server. */
  photoCount = 0,
}: {
  siteCode: string;
  loadId: string;
  onSkipped: () => void;
  photoCount?: number;
}) {
  const t = useT();
  const [mode, setMode] = useState<'choose' | 'add'>('choose');
  const [hasPhoto, setHasPhoto] = useState(false);
  const [lbs, setLbs] = useState('');
  const [isPending, startTransition] = useTransition();
  // ADR-0082 — a stage refusal may be a takeover, and a Server Action's message
  // is redacted in production, so the client cannot read why. Asked, not guessed.
  const claimLost = useClaimLossGuard(siteCode, loadId);
  const [error, setError] = useState<string | null>(null);

  // Hoisted ABOVE the `choose` early return: hooks may not be called
  // conditionally, and `lbsValid` is a pure derivation that reads the same
  // state either way. Nothing about the rendered output moves.
  const lbsNum = Number.parseInt(lbs, 10);
  const lbsValid = Number.isInteger(lbsNum) && lbsNum >= 1 && lbsNum <= 100_000;

  // ADR-0122 — both sub-modes declared, because a control that is NOT RENDERED
  // is not a live control. Letting the hook fall out of the tree with its button
  // would shrink the denominator and let a dead screen read as healthy.
  //
  // The `add` sub-mode is a REAL second instance of the ADR-0121 trap and is why
  // this stage is instrumented rather than waved past: it has no way back to
  // `choose`, so an operator who re-enters a load whose weight ticket is already
  // on the server and taps "Add weight" finds capture withheld (ADR-0109),
  // "add another" unrendered, and Continue held by `!hasPhoto` — which no amount
  // of typing a weight can satisfy. ADR-0121 recorded stage 2 as safe on the
  // strength of the `choose` screen's None button; that is true only until the
  // operator leaves `choose`.
  const choosing = mode === 'choose';
  useLiveControl('weight_add', !choosing ? 'not_rendered' : null);
  useLiveControl('weight_none', !choosing ? 'not_rendered' : isPending ? 'pending' : null);
  const continueReason: StageDisableReason | null = choosing
    ? 'not_rendered'
    : isPending
      ? 'pending'
      : !hasPhoto
        ? 'no_photo'
        : !lbsValid
          ? 'invalid_weight'
          : null;
  useLiveControl('weight_continue', continueReason);

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
        initialCount={photoCount}
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
        disabled={continueReason !== null}
        onClick={() =>
          startTransition(async () => {
            try {
              setError(null);
              await weightCapturedAction(siteCode, loadId, lbsNum);
            } catch (e) {
              // The claim may have moved while this iPad sat on the stage screen.
              // Refresh in that case: the page re-renders as the held-by panel and
              // NAMES the new holder, instead of a redacted server message.
              if (await claimLost()) return;
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
