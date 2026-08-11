'use client';

import type { CountMode, LoadStatus } from '@prisma/client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/provider';
import { StageBol } from './stage-bol';
import { StageWeight } from './stage-weight';
import { StageDoor } from './stage-door';
import { StageDecision } from './stage-decision';
import { StageStacks } from './stage-stacks';
import { StageReject } from './stage-reject';
import { StageFinish } from './stage-finish';
import { VoidLoadPanel } from './void-load-panel';

// Stage dispatch. The visible "stage" is a function of `load.status`
// plus a tiny client-only flag for the weight sub-stage (whether the
// operator picked Add or None — both leave the load on `arrived` so
// the server status alone can't tell them apart). Keeps server
// truth authoritative; reload mid-flow re-derives the right stage.

type LoadView = {
  id: string;
  status: LoadStatus;
  unload_started_at: string | null;
  total_units: number | null;
  stacks: Array<{ id: string; stack_index: number; unit_count: number; count_mode: CountMode }>;
};

type Props = {
  siteCode: string;
  load: LoadView;
  operatorName: string;
};

export function LoadWorkflow({ siteCode, load, operatorName }: Props) {
  const { t } = useI18n();
  // `weightDecided` only lives during the `arrived` phase; once the
  // server status moves on, this ref is moot.
  const [weightSkipped, setWeightSkipped] = useState(false);
  const [showReject, setShowReject] = useState(false);

  // ADR-0078 — the replay tick and the pending pill that used to live here are
  // GONE, folded into `ConnectionState` in the floor chrome. This screen ran a
  // mount sweep + `online` listener + 30s sweep + 5s refresh; `pending-banner.tsx`
  // ran a near-identical loop with no sweep. Two loops meant the queue drained
  // on the load workflow and merely displayed on the queue page, and neither
  // showed whether the iPad could reach anything — the half JT actually asked
  // for. One loop, in the chrome, on all nine screens.

  if (load.status === 'submitted' || load.status === 'rejected') {
    // ADR-0074 Amendment 1 — this branch used to render ONE paragraph:
    // "Load {{status}}. Returning to the name picker…" — and then return
    // nowhere. No link, no button, no redirect, no timer. The copy promised a
    // navigation the component never performed, in three locales.
    //
    // It was justified as "defensive — the submit/reject actions sign the
    // operator out and redirect, so reaching here is rare". The premise was
    // false in the way that mattered: this screen is reachable WITHOUT
    // submitting anything. Tapping a check-in card whose `expected_loads` slot
    // was already consumed routes — correctly, through the idempotent
    // `startInboundLoad` — to the existing child load, and a terminal child
    // lands you exactly here. On 2026-08-10 the Santa Rita operator hit this on
    // every tap, and the screen's only offer was a sentence claiming it was
    // taking them somewhere.
    //
    // A dead end with reassuring copy is worse than a bare dead end: it tells
    // the operator to WAIT rather than to act. Same class as the ADR-0065 Am.1
    // "Something went wrong" page and the ADR-0082 silent redirect loop, and the
    // fix is the same one — a named destination the thumb can reach.
    const statusLabel =
      load.status === 'submitted' ? t('workflow.status_submitted') : t('workflow.status_rejected');
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-md bg-dr3-green-dark/50 p-4 text-center">
          {t('workflow.load_done', { status: statusLabel })}
        </p>
        <Link
          href={`/operator/${siteCode}/queue`}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-center text-base font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream"
        >
          {t('workflow.back_to_queue')}
        </Link>
      </div>
    );
  }

  if (load.status === 'arrived' && !weightSkipped) {
    // BOL captured? We track it via the photo-row presence rather
    // than client state, but for T-006 the simplest thing is to
    // surface BOL first and require the operator to confirm capture
    // before showing weight. Since BOL doesn't change `load.status`
    // (it stays `arrived`), we show BOL until the operator confirms,
    // then fall through to weight.
    //
    // For minimum-tap UX we just chain BOL → weight in a single
    // visual flow with internal client state.
    return (
      <>
        <FromBol
          siteCode={siteCode}
          load={load}
          onBolDone={() => setWeightSkipped(false)}
          onWeightSkipped={() => setWeightSkipped(true)}
        />
        <VoidLoadPanel siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'arrived' && weightSkipped) {
    return (
      <>
        <StageDoor siteCode={siteCode} loadId={load.id} />
        <VoidLoadPanel siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'weight_captured') {
    return (
      <>
        <StageDoor siteCode={siteCode} loadId={load.id} />
        <VoidLoadPanel siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'unload_started') {
    if (showReject) {
      return (
        <>
          <StageReject siteCode={siteCode} loadId={load.id} onCancel={() => setShowReject(false)} />
        </>
      );
    }
    return (
      <>
        <StageDecision siteCode={siteCode} loadId={load.id} onReject={() => setShowReject(true)} />
        <VoidLoadPanel siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'in_progress') {
    return (
      <>
        <StageStacks
          siteCode={siteCode}
          loadId={load.id}
          unloadStartedAt={load.unload_started_at}
          existingStacks={load.stacks}
        />
        <VoidLoadPanel siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'finished') {
    return (
      <>
        <StageFinish
          siteCode={siteCode}
          loadId={load.id}
          operatorName={operatorName}
          totalUnits={load.total_units}
        />
        <VoidLoadPanel siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  return (
    <>
      <p>{t('workflow.unhandled_status', { status: load.status })}</p>
    </>
  );
}

function FromBol({
  siteCode,
  load,
  onWeightSkipped,
}: {
  siteCode: string;
  load: LoadView;
  onBolDone: () => void;
  onWeightSkipped: () => void;
}) {
  const [bolDone, setBolDone] = useState(false);
  if (!bolDone) {
    return <StageBol siteCode={siteCode} loadId={load.id} onCaptured={() => setBolDone(true)} />;
  }
  return <StageWeight siteCode={siteCode} loadId={load.id} onSkipped={onWeightSkipped} />;
}
