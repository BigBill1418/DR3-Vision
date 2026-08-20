'use client';

import { useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { beginUnloadAction } from '../../actions';
import { useLiveControl } from './stage-liveness';

// Stage 4 — Begin unload OR Reject load. Two equal-weight buttons.

export function StageDecision({
  siteCode,
  loadId,
  onReject,
}: {
  siteCode: string;
  loadId: string;
  onReject: () => void;
}) {
  const t = useT();
  const [isPending, startTransition] = useTransition();

  // ADR-0122 — Reject carries no `disabled` at all, so this stage can only ever
  // be all-dark while a transition is in flight. Registered anyway: the value of
  // an inventory is that it covers the stages nobody expects to break.
  useLiveControl('decision_begin_unload', isPending ? 'pending' : null);
  useLiveControl('decision_reject', null);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-2xl font-bold">{t('stage_decision.heading')}</h2>
        <p className="text-sm text-dr3-cream/70">{t('stage_decision.subheading')}</p>
      </header>
      <div className="grid grid-cols-2 gap-4">
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              await beginUnloadAction(siteCode, loadId);
            })
          }
          className="rounded-lg bg-dr3-green px-6 py-8 text-xl font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('stage_decision.begin_unload')}
        </button>
        <button
          type="button"
          onClick={onReject}
          className="rounded-lg bg-red-700/70 px-6 py-8 text-xl font-semibold text-white transition-colors hover:bg-red-700"
        >
          {t('stage_decision.reject_load')}
        </button>
      </div>
    </section>
  );
}
