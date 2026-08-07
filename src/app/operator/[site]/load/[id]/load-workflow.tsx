'use client';

import type { CountMode, LoadStatus } from '@prisma/client';
import { useState } from 'react';
import { useI18n } from '@/i18n/provider';
import { StageBol } from './stage-bol';
import { StageWeight } from './stage-weight';
import { StageDoor } from './stage-door';
import { StageDecision } from './stage-decision';
import { StageStacks } from './stage-stacks';
import { StageReject } from './stage-reject';
import { StageFinish } from './stage-finish';

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
    // Defensive — submit/reject server actions sign the operator
    // out and redirect, so reaching here is rare. Render a soft
    // message rather than nothing.
    const statusLabel =
      load.status === 'submitted' ? t('workflow.status_submitted') : t('workflow.status_rejected');
    return (
      <>
        <p className="rounded-md bg-dr3-green-dark/50 p-4 text-center">
          {t('workflow.load_done_returning', { status: statusLabel })}
        </p>
      </>
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
      </>
    );
  }

  if (load.status === 'arrived' && weightSkipped) {
    return (
      <>
        <StageDoor siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'weight_captured') {
    return (
      <>
        <StageDoor siteCode={siteCode} loadId={load.id} />
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
