'use client';

import { useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { bolCapturedAction } from '../../actions';
import { PhotoInput } from './photo-input';

// Stage 1 — forced BOL photo. Per SPRINT-1-PLAN: "Forced BOL photo
// (timer does not start)". The Continue button stays disabled until
// the camera input fires `onCaptured` with a file handle.

export function StageBol({
  siteCode,
  loadId,
  onCaptured,
}: {
  siteCode: string;
  loadId: string;
  onCaptured: () => void;
}) {
  const t = useT();
  const [hasFile, setHasFile] = useState(false);
  const [isPending, startTransition] = useTransition();

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
      />
      <button
        type="button"
        disabled={!hasFile || isPending}
        onClick={() =>
          startTransition(async () => {
            await bolCapturedAction(siteCode, loadId);
            onCaptured();
          })
        }
        className="rounded-lg bg-dr3-chartreuse px-6 py-4 text-lg font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_bol.saving') : t('stage_bol.continue')}
      </button>
    </section>
  );
}
