'use client';

// ADR-0122 — the zero-live-controls detector for the seven load-workflow stages.
//
// ## What ADR-0121 cost us, and why a beacon is the fast follow
//
// On 2026-08-20 load H-137810 sat at `arrived` for 90+ minutes while three
// operators took it over in turn, each landing on a screen with nothing they
// could tap. The incident generated ZERO server traffic that looked wrong: the
// app was healthy, Postgres was idle, check-ins and photo uploads were SUCCEEDING
// throughout. Every monitor the fleet owns was green while the floor was stopped,
// because a trapped operator does not make requests — that is what trapped means.
// The discovery mechanism was Bill's phone at 12:52 PT, sixteen minutes after the
// trap closed at 12:36:35.
//
// ADR-0100 built `DeadEndBeacon` for exactly this class and mounted it on the
// list surfaces. It was absent from all seven `stage-*.tsx` files. This module is
// the mount, generalised: it does not ask a stage to DECLARE "I am a dead end",
// it MEASURES whether the stage has a live control.
//
// ## Why registration, and not a DOM scan
//
// The obvious implementation — walk the rendered subtree and count
// `button:not([disabled])`, which is what `stage-reentry.test.tsx` does — was
// rejected. Two reasons, and the second is disqualifying:
//
//   1. `photo-input.tsx` renders an `<input type="file" className="hidden">` that
//      is never `disabled`. A naive selector counts it as a live control and the
//      detector never fires — a guard that measures nothing, which is worse than
//      no guard because it reads as coverage.
//   2. Excluding it needs CSS visibility, and jsdom does no layout. The detector
//      would take a different branch under test than in production, so no test
//      could falsify it. An instrument nobody can prove wrong is not an
//      instrument.
//
// So each control REGISTERS itself, next to where it renders, with the reason it
// is disabled — and the same expression feeds the button's `disabled` prop. The
// registration cannot drift from the DOM because it IS the DOM's input.
// `stage-liveness.test.tsx` closes the loop the other way: it mounts the real
// compositions and asserts the registry's verdict agrees with a button count
// taken from the rendered output, across the whole disable matrix.
//
// ## Why the reason, and not just a boolean
//
// A screen where every control is dark because a Server Action is IN FLIGHT is
// not a dead end, it is a busy screen — and it is the single most common
// all-disabled state on this floor, since every tap passes through one. A
// detector that could not tell those apart would page Bill on every tap and be
// muted within the hour. See `TRANSIENT_DISABLE_REASONS`.
//
// ## Behaviour-neutral by construction
//
// The provider renders `{children}` and no DOM node of its own, so it cannot
// change layout. `useLiveControl` is a `useEffect` that writes to a ref — it
// renders nothing, returns nothing, and gates nothing. Every `disabled` prop in
// the seven stage files is truth-equivalent to what shipped in #286;
// `stage-reentry.test.tsx` and the two existing photo-input suites are the
// standing proof of that and were not modified.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isStageDeadEnd,
  type StageControlId,
  type StageDisableReason,
  type StageId,
} from '@/lib/floor/stage-controls';

export type { StageControlId, StageDisableReason, StageId };

type Registry = Map<StageControlId, StageDisableReason | null>;

interface LivenessApi {
  register: (id: StageControlId, reason: StageDisableReason | null) => void;
  unregister: (id: StageControlId) => void;
}

const StageLivenessContext = createContext<LivenessApi | null>(null);

/**
 * Fired at most once per (stage, load) per page lifetime.
 *
 * Module-scoped for the same reason `dead-end-beacon.tsx`'s Set is: React
 * re-renders freely and `<StrictMode>` double-mounts, so counting evaluations
 * would measure React rather than the floor. A different load reaching the same
 * dead stage is a genuinely different event and gets its own entry.
 */
const reported = new Set<string>();

/** Exported for tests only — a shared Set would make cases order-dependent. */
export function __resetStageLiveness(): void {
  reported.clear();
}

/**
 * Declare one control's liveness to the enclosing boundary.
 *
 * Call it UNCONDITIONALLY, at the top level of the component that renders the
 * control, and pass `'not_rendered'` when the control is withheld. A control that
 * is absent from the DOM is not a live control, and letting the hook fall out of
 * the tree with it would silently shrink the denominator — the detector would
 * then find "every registered control is enabled" on a screen whose only
 * registered control is the one still showing.
 *
 * No-ops outside a boundary, so `PhotoInput` stays usable anywhere.
 */
export function useLiveControl(id: StageControlId, reason: StageDisableReason | null): void {
  const api = useContext(StageLivenessContext);
  useEffect(() => {
    if (!api) return;
    api.register(id, reason);
    return () => api.unregister(id);
  }, [api, id, reason]);
}

/** Shape posted to `/api/operator/<site>/dead-end`, so the two ends agree. */
export interface StageDeadEndReport {
  surface: 'load_stage';
  state: 'no_live_controls';
  objectId: string;
  stage: StageId;
  reasons: Partial<Record<StageControlId, StageDisableReason>>;
}

/**
 * Wrap the rendered stage. Renders NO DOM.
 *
 * `stage` and `children` are produced together at the dispatch site so the label
 * cannot name a different screen than the one that rendered — the same reasoning
 * `DeadEndBeacon` gives for living inside the branch it measures.
 */
export function StageLivenessBoundary({
  siteCode,
  loadId,
  stage,
  children,
}: {
  siteCode: string;
  loadId: string;
  stage: StageId;
  children: React.ReactNode;
}) {
  const registry = useRef<Registry>(new Map());
  // Bumped only when a registration actually CHANGES the map, so the effect below
  // re-runs on every real transition and the loop terminates.
  const [revision, setRevision] = useState(0);

  const api = useMemo<LivenessApi>(
    () => ({
      register(id, reason) {
        const current = registry.current;
        if (current.has(id) && current.get(id) === reason) return;
        current.set(id, reason);
        setRevision((n) => n + 1);
      },
      unregister(id) {
        if (registry.current.delete(id)) setRevision((n) => n + 1);
      },
    }),
    [],
  );

  const report = useCallback(
    (body: StageDeadEndReport) => {
      void fetch(`/api/operator/${siteCode}/dead-end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Survives the navigation that follows an operator giving up — precisely
        // the event most worth having.
        keepalive: true,
        body: JSON.stringify(body),
      }).catch(() => {
        // Offline is the common case on this floor. Hard rule #9 reserves the one
        // durable store on the iPad for the operator's WORK; telemetry does not
        // get to compete with it.
      });
    },
    [siteCode],
  );

  useEffect(() => {
    // Child effects commit before parent effects, so by the time this runs every
    // control below has registered. `revision` re-runs it on every later change.
    void revision;

    const entries = [...registry.current.entries()];
    if (!isStageDeadEnd(entries)) return;

    const key = `${stage}:${loadId}`;
    if (reported.has(key)) return;
    reported.add(key);

    const reasons: Partial<Record<StageControlId, StageDisableReason>> = {};
    for (const [id, reason] of entries) if (reason !== null) reasons[id] = reason;

    report({ surface: 'load_stage', state: 'no_live_controls', objectId: loadId, stage, reasons });
  }, [revision, stage, loadId, report]);

  return <StageLivenessContext.Provider value={api}>{children}</StageLivenessContext.Provider>;
}
