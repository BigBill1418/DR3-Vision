'use client';

import type { LoadStatus, PhotoKind } from '@prisma/client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/provider';
import { floorStatusKey } from '@/lib/loads/floor-status-label';
import { DeadEndBeacon } from '../../../_components/dead-end-beacon';
import { StageBol } from './stage-bol';
import { StageWeight } from './stage-weight';
import { StageDoor } from './stage-door';
import { StageDecision } from './stage-decision';
import { StageStacks } from './stage-stacks';
import { StageReject } from './stage-reject';
import { StageFinish } from './stage-finish';
import { StageLivenessBoundary } from './stage-liveness';
import { selectStage, WORKING_STATUSES } from '@/lib/loads/stage-selection';
import { VoidLoadPanel } from './void-load-panel';
import { ReviewPanel, type ReviewStack } from './review-panel';

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
  /** ADR-0090 Am.1 — read by the review panel; null when no ticket was taken. */
  weight_lbs: number | null;
  /**
   * ADR-0090 Am.1 / ADR-0109 — how many photos of each kind the load already
   * holds. A kind with no photos is absent, which reads the same as 0 at every
   * call site.
   *
   * ONE field, two readers, and that is deliberate. It seeds each stage's "add
   * another photo" affordance (ADR-0109) AND answers the review panel's "was the
   * BOL captured" (ADR-0090 Am.1), which is `> 0`. It replaced a `photo_kinds`
   * array carrying the same fact in a lossier shape: two fields would have let a
   * caller supply a kind list that disagreed with the counts, and ADR-0091 is the
   * standing lesson about one fact with two representations.
   */
  photo_counts: Partial<Record<PhotoKind, number>>;
  /**
   * ADR-0124 — the operator declared this load has no weight ticket.
   *
   * A SERVER fact (`inbound_loads.weight_skipped_at IS NOT NULL`), where it used
   * to be a `useState` in this file. The "None" path is the only step in the
   * flow that leaves no other trace — no photo, no status move, no weight — so
   * it is the one that needed a column.
   */
  weight_skipped: boolean;
  stacks: ReviewStack[];
};

type Props = {
  siteCode: string;
  load: LoadView;
  operatorName: string;
};

export function LoadWorkflow({ siteCode, load, operatorName }: Props) {
  const { t } = useI18n();
  const [showReject, setShowReject] = useState(false);
  // ADR-0090 Am.1 B — the review view. The FIRST back-edge in this component:
  // `weightSkipped` and `bolDone` are one-way latches, and only `showReject` had
  // a control that reset it.
  const [review, setReview] = useState(false);
  // ADR-0124 — `bolDone` and `weightSkipped` are GONE. Both were client
  // `useState`, and both recorded, in one browser tab, that a step done on the
  // server was finished. `bolDone` is the latch that put three operators in turn
  // onto a BOL screen for a load whose BOL photo was already in Postgres on
  // 2026-08-20 (ADR-0121); `weightSkipped` is the same shape with a softer
  // landing, because "None" is always live. The stage is now a function of
  // server facts alone — see `@/lib/loads/stage-selection`.

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

  // The reject sub-stage is a decision screen mid-commitment and already carries
  // its OWN back control (`onCancel`). It is deliberately left out of the review
  // frame below: two differently-worded "back" controls on one screen are two
  // things that have to agree about what back means.
  if (load.status === 'unload_started' && showReject) {
    return (
      <StageLivenessBoundary siteCode={siteCode} loadId={load.id} stage="reject">
        <StageReject
          siteCode={siteCode}
          loadId={load.id}
          onCancel={() => setShowReject(false)}
          photoCount={load.photo_counts.rejection ?? 0}
        />
      </StageLivenessBoundary>
    );
  }

  if (!WORKING_STATUSES.includes(load.status)) {
    // Audit D-4 — this branch WAS the whole of it:
    //
    //     return <p>{t('workflow.unhandled_status', { status: load.status })}</p>;
    //
    // No Link, no button, not even a wrapping element, and the copy interpolated
    // a raw enum token — "Unhandled status: voided", translated just as uselessly
    // into Spanish and Urdu. Its sibling seven lines above carries the comment
    // "A dead end with reassuring copy is worse than a bare dead end" and a
    // <Link> to the queue. This branch got neither.
    //
    // WHICH STATUSES LAND HERE: `verified`, `voided`, `submitted_to_mymrc`,
    // `processed`. Production at 2026-08-11 22:04 PT held 627 `verified` loads
    // and zero `voided` ones — but the 627 all carry `assigned_operator_id IS
    // NULL`, so they route to `HeldByPanel` instead. That is luck from a
    // different code path, not coverage.
    //
    // The reachable one is `voided`. `voidLoad` (`load-service.ts`) sets
    // `status: 'voided'` and NULLs `expected_load_id` but leaves
    // `assigned_operator_id` INTACT — so the operator who voids a load is still
    // its holder, `heldByOther` is false, and one Back tap after the void
    // redirect lands them here. The void panel is live in the workflow and has
    // simply not been used yet; the first operator to use it hits this.
    //
    // The fix is the one its sibling already had, plus the enum→label map that
    // `held-by-panel.tsx` already maintained for exactly this failure — now
    // shared (`floor-status-label.ts`) rather than copied a fourth time. A
    // status this build has never heard of reads "Status unknown", never a raw
    // token and never a confident wrong stage.
    return (
      <div className="flex flex-col gap-4">
        {/* ADR-0100 §P0 — this branch now has a route, but it is still a state
            with no WORK in it, and how often the floor lands here is the only
            way to know whether the void panel is being used as intended. */}
        <DeadEndBeacon siteCode={siteCode} surface="load" state="load_closed" objectId={load.id} />
        <div className="rounded-md bg-dr3-green-dark/50 p-4 text-center" data-testid="load-closed">
          <p className="text-lg font-bold">{t(floorStatusKey(load.status))}</p>
          <p className="mt-2 text-sm text-dr3-cream/80">{t('workflow.closed_body')}</p>
        </div>
        <Link
          href={`/operator/${siteCode}/queue`}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-center text-base font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream"
        >
          {t('workflow.back_to_queue')}
        </Link>
      </div>
    );
  }

  // ADR-0122 / ADR-0124 — the stage id comes from `selectStage`, a pure function
  // of SERVER FACTS, and the node is chosen from it in one `switch`. Two things
  // fall out of that shape and both matter:
  //
  //   - the id the beacon reports can never name a different screen than the one
  //     that rendered, because the id is what picked the screen;
  //   - the whole dispatch matrix is exercisable without mounting React, so the
  //     seam that produced the 2026-08-20 incident is examinable rather than
  //     reachable only through the DOM.
  //
  // `selectStage` returns null only for statuses the branch above already
  // handled, so the fallthrough is unreachable — it renders the closed-load card
  // rather than throwing, because an operator standing at a truck is owed a way
  // out and never a stack trace (ADR-0074 Am.1).
  const stageId = selectStage({
    status: load.status,
    bolPhotoCount: load.photo_counts.bol ?? 0,
    weightSkipped: load.weight_skipped,
  });

  const stageNode = ((): React.ReactNode => {
    switch (stageId) {
      case 'bol':
        return (
          <StageBol siteCode={siteCode} loadId={load.id} photoCount={load.photo_counts.bol ?? 0} />
        );
      case 'weight':
        return (
          <StageWeight
            siteCode={siteCode}
            loadId={load.id}
            photoCount={load.photo_counts.weight_ticket ?? 0}
          />
        );
      case 'door':
        return (
          <StageDoor
            siteCode={siteCode}
            loadId={load.id}
            photoCount={load.photo_counts.door_open ?? 0}
          />
        );
      case 'decision':
        return (
          <StageDecision
            siteCode={siteCode}
            loadId={load.id}
            onReject={() => setShowReject(true)}
          />
        );
      case 'stacks':
        return (
          <StageStacks
            siteCode={siteCode}
            loadId={load.id}
            unloadStartedAt={load.unload_started_at}
            existingStacks={load.stacks}
          />
        );
      default:
        return (
          <StageFinish
            siteCode={siteCode}
            loadId={load.id}
            operatorName={operatorName}
            totalUnits={load.total_units}
          />
        );
    }
  })();

  return (
    <>
      {/* ADR-0090 Am.1 B — HIDDEN, not unmounted, while the review is open.
          Every stage holds operator work in local state that exists nowhere
          else: `StageStacks` carries the optimistic `tmp-` stacks queued while
          offline plus the running total and the chosen count mode, `StageWeight`
          carries a typed weight and a captured photo. Unmounting to show the
          review would throw all of it away and drop the operator back at the top
          of the stage — which is a worse dead end than the one this panel exists
          to remove. */}
      <div hidden={review}>
        <StageLivenessBoundary siteCode={siteCode} loadId={load.id} stage={stageId ?? 'finish'}>
          {stageNode}
        </StageLivenessBoundary>
      </div>
      {review ? (
        <ReviewPanel
          siteCode={siteCode}
          load={{
            id: load.id,
            status: load.status,
            weightLbs: load.weight_lbs,
            // Projected here rather than carried alongside — see `photo_counts`.
            photoKinds: Object.keys(load.photo_counts) as PhotoKind[],
            stacks: load.stacks,
          }}
          onClose={() => setReview(false)}
        />
      ) : (
        <>
          <button
            type="button"
            data-testid="review-open"
            onClick={() => setReview(true)}
            // Quiet, and ABOVE the void. Going back to look is the common
            // correction; closing the load is the rare one, and the two must not
            // read as equally weighted.
            className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-semibold text-dr3-cream/80 underline-offset-4 transition-colors hover:text-dr3-cream hover:underline"
          >
            {t('load_review.open')}
          </button>
          <VoidLoadPanel siteCode={siteCode} loadId={load.id} />
        </>
      )}
    </>
  );
}
