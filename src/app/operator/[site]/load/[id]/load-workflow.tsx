'use client';

import type { CountMode, LoadStatus } from '@prisma/client';
import { useEffect, useState } from 'react';
import { pendingCount, replayAll } from '@/lib/offline-queue';
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
  const { t, tPlural } = useI18n();
  // `weightDecided` only lives during the `arrived` phase; once the
  // server status moves on, this ref is moot.
  const [weightSkipped, setWeightSkipped] = useState(false);
  const [showReject, setShowReject] = useState(false);

  // T-009 — offline-queue replay tick. Three triggers:
  //   1. Mount — sweep anything queued from a prior session.
  //   2. `online` event — Safari fires this when wifi/cell reconnects.
  //   3. 30s interval while the workflow page is mounted — covers the
  //      case where the iPad reports "online" but the app server is
  //      briefly unreachable.
  // The pill below taps `replayAll()` directly for an operator-driven
  // retry. `replayAll()` itself dedupes concurrent invocations.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const n = await pendingCount();
        if (!cancelled) setPending(n);
      } catch {
        // SSR / IndexedDB unavailable — non-fatal, the queue is a
        // progressive-enhancement layer.
      }
    };
    const sweep = async () => {
      try {
        await replayAll();
      } catch {
        // Swallow — failed rows are persisted with last_error and
        // surfaced on the next refresh.
      } finally {
        await refresh();
      }
    };
    void sweep();
    const onOnline = () => void sweep();
    window.addEventListener('online', onOnline);
    const tick = window.setInterval(() => void sweep(), 30_000);
    const refreshTick = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.clearInterval(tick);
      window.clearInterval(refreshTick);
    };
  }, []);

  const onPillTap = () => {
    void replayAll().then(() => pendingCount().then(setPending));
  };

  const pill =
    pending > 0 ? <PendingPill count={pending} onTap={onPillTap} label={tPlural('pending_pill.label', pending, { count: pending })} /> : null;

  if (load.status === 'submitted' || load.status === 'rejected') {
    // Defensive — submit/reject server actions sign the operator
    // out and redirect, so reaching here is rare. Render a soft
    // message rather than nothing.
    const statusLabel =
      load.status === 'submitted' ? t('workflow.status_submitted') : t('workflow.status_rejected');
    return (
      <>
        {pill}
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
        {pill}
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
        {pill}
        <StageDoor siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'weight_captured') {
    return (
      <>
        {pill}
        <StageDoor siteCode={siteCode} loadId={load.id} />
      </>
    );
  }

  if (load.status === 'unload_started') {
    if (showReject) {
      return (
        <>
          {pill}
          <StageReject
            siteCode={siteCode}
            loadId={load.id}
            onCancel={() => setShowReject(false)}
          />
        </>
      );
    }
    return (
      <>
        {pill}
        <StageDecision siteCode={siteCode} loadId={load.id} onReject={() => setShowReject(true)} />
      </>
    );
  }

  if (load.status === 'in_progress') {
    return (
      <>
        {pill}
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
        {pill}
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
      {pill}
      <p>{t('workflow.unhandled_status', { status: load.status })}</p>
    </>
  );
}

function PendingPill({ onTap, label }: { count: number; onTap: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="mb-3 w-full rounded-md bg-dr3-chartreuse/20 px-3 py-2 text-start text-xs font-medium text-dr3-chartreuse hover:bg-dr3-chartreuse/30"
    >
      ⏳ {label}
    </button>
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
