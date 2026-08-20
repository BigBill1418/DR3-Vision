// ADR-0100 / ADR-0094 §P0 — the instrument that turns Bill's phone into a metric.
//
// ## Why this exists
//
// ADR-0094 measured that **43 of 89 scheduled slots — 48.3% — diverge from the
// happy path**, and that the system's response to nearly every divergence it did
// not model is the same: a card with information on it and no way to act. It then
// named the thing to build FIRST, ahead of any fix:
//
// > "today, the discovery mechanism for this entire defect class is *Bill's
// > phone*. This converts it into a metric. It requires no domain redesign, it
// > works on every branch including the ones not yet found, and it turns RC-5's
// > maturation curve from a surprise into a readout."
//
// So this module is deliberately NOT a fix for anything. It buys knowing, one
// working day ahead of a phone call.
//
// ## Why a log line and a counter, and NOT a table
//
// Cheapest thing that is genuinely queryable. The repo already ships both halves
// of an ops surface the fleet watches — pino → Alloy → **Loki** (ADR-0022 §3) and
// prom-client → **Prometheus/Grafana** (ADR-0022 §4) — so a structured line plus a
// labelled counter is queryable tonight with no migration, no new table to
// retain, and no new thing that can be down.
//
// A `dead_end_events` table was the alternative and is worse here on every axis
// that matters this week: it needs a migration, it needs retention (these are
// high-frequency renders, not audit facts — hard rule #6 is about audit rows, and
// deliberately conflating the two would bury the audit log), and it would still
// need a Grafana panel to be read. Loki gives full-fidelity events with every
// label for ad-hoc questions; Prometheus gives the cheap aggregate for a tile and
// for the P0 threshold rule. Neither needs a dashboard to answer a question
// tonight, which is the bar ADR-0094 set.
//
// ## The ADR-0037 grading, stated here because it is easy to get wrong later
//
// A dead-end render is **NOT actionable within 5 minutes**, so it does not page.
// It is a dashboard tile and a digest line. ADR-0094 §P0 is explicit that only a
// THRESHOLD breach — the same object dead-ended by the same user 3+ times in an
// hour, the signature of somebody stuck right now — could ever earn `high`. That
// rule is not built here; the counter's labels are chosen so it CAN be written
// later without re-instrumenting anything.

import { log } from '@/lib/observability/logger';
import { deadEndRenders, writeRefusals } from '@/lib/observability/metrics';

/**
 * Every floor surface that can render an actionless state.
 *
 * A CLOSED union, not a free string. Two reasons, and the second is the load
 * bearing one: an open string makes the Prometheus label unbounded, which is how
 * a counter turns into a cardinality incident; and a closed set means adding a
 * surface is a compile error at the call site rather than a silent gap in the
 * very instrument that exists to find silent gaps.
 */
export type DeadEndSurface =
  | 'hauls'
  | 'queue'
  | 'load'
  | 'conflicts'
  | 'count'
  | 'inbound'
  | 'processed'
  | 'dropoff'
  | 'site_picker'
  /**
   * ADR-0122 — one of the seven `stage-*.tsx` screens inside a load. DISTINCT
   * from `load`, which is the workflow shell: `load` reports a status the
   * workflow will not work (voided, verified), a state the app knows it is in.
   * `load_stage` reports the opposite — a stage the app believes is WORKABLE
   * while every control on it is dark. That is a defect report, not a state.
   */
  | 'load_stage';

/**
 * The named condition. Also closed, and named for the OPERATOR'S situation
 * rather than for the code branch — "the truck's slot was withdrawn" is a fact
 * about the yard that will outlive whichever `if` currently produces it.
 */
export type DeadEndState =
  | 'slot_withdrawn' // ADR-0099 — MyMRC cancelled the slot
  | 'view_only' // no sibling slot, or an undated one
  | 'load_closed' // audit D-4 — verified / voided / submitted_to_mymrc / processed
  | 'already_worked' // audit D-5 — the slot is spent
  | 'no_portal_feed' // audit D-6 — Eugene's permanent hauls state
  | 'no_inbound_days' // audit D-6
  | 'queue_unreadable' // audit D-14 — IndexedDB would not answer
  | 'hold_gone' // audit D-9 — a manager already resolved it
  | 'no_sites' // audit D-18
  /**
   * ADR-0122 — the stage rendered with NO enabled control. The one state in this
   * union that is not a situation in the yard: it is the application failing to
   * offer the operator a next action, measured rather than declared. It is also
   * the only one that pages — see `publishStageDeadEndAlert`.
   */
  | 'no_live_controls';

/** The two refusals every floor WRITE client can earn (see `write-refusal.tsx`). */
export type WriteRefusalKind = 'wrong_day' | 'signed_out';

export interface DeadEndEvent {
  surface: DeadEndSurface;
  state: DeadEndState;
  /**
   * The load or slot this is about, when there is one. Never free text.
   *
   * `| undefined` explicitly, because `exactOptionalPropertyTypes` is on: a
   * caller that spreads a partial and lands `objectId: undefined` is the normal
   * case here, and forcing every one of them to branch would push the `?? null`
   * out to nine call sites instead of keeping it in the one place that
   * normalises it.
   */
  objectId?: string | null | undefined;
  siteCode: string;
  /** Resolved SERVER-SIDE from the session — never accepted from a client. */
  userId: string;
  role: string;
  locale: string;
  /**
   * ADR-0122 — which of the seven load stages, when `surface` is `load_stage`.
   *
   * Deliberately NOT a Prometheus label. `deadEndRenders` is labelled
   * (surface, state, site) and stays that way: a fourth label multiplies the
   * series count for every existing caller and quietly changes what the shipped
   * queries mean. Loki holds the full-fidelity event — exactly the split this
   * module's header argues for — so "which stage" is one filter away without
   * touching the counter's shape.
   */
  stage?: string | undefined;
  /**
   * ADR-0122 — control id → why it was dark, at the moment of the render.
   *
   * The whole diagnostic payload. A `no_live_controls` line without it says a
   * screen was dead; with it, the first question anyone asks ("which control,
   * and why?") is answered from the log instead of from a reproduction attempt.
   * Log-only, for the same cardinality reason as `stage`.
   */
  disableReasons?: Readonly<Record<string, string>> | undefined;
}

/**
 * Record one render of a state that offers no control.
 *
 * Never throws and never awaits anything slow. A telemetry call that can fail the
 * render it is measuring would be a strictly worse defect than the one being
 * measured — and this repo has the receipts for that shape: ADR-0019.5's counters
 * reported delivery attempts as successes while the pages were being dropped, so
 * an instrument that lies is the failure mode to design against. Here the two
 * sinks are independent (a Prometheus registry error cannot suppress the Loki
 * line) and both are wrapped.
 */
export function recordDeadEnd(e: DeadEndEvent): void {
  try {
    deadEndRenders.inc({ surface: e.surface, state: e.state, site: e.siteCode });
  } catch {
    // A metrics-registry failure must not cost us the log line, which is the
    // higher-fidelity of the two sinks.
  }
  try {
    log.info(
      {
        evt: 'floor.dead_end',
        surface: e.surface,
        state: e.state,
        object_id: e.objectId ?? null,
        site: e.siteCode,
        user_id: e.userId,
        role: e.role,
        locale: e.locale,
        // ADR-0122 — absent on every pre-existing caller, so no shipped Loki
        // query changes shape; present only on `load_stage`.
        ...(e.stage ? { stage: e.stage } : {}),
        ...(e.disableReasons ? { disable_reasons: e.disableReasons } : {}),
      },
      // A human-readable message so the Loki line is greppable without knowing
      // the label schema — the first question anyone asks is "show me today's".
      `floor dead end: ${e.surface}/${e.state}`,
    );
  } catch {
    /* observability is never load-bearing */
  }
}

/**
 * Record a CLASSIFIED write refusal — the other half of ADR-0094 §P0.
 *
 * Distinct from a dead-end render on purpose. A dead end is a screen that offers
 * nothing; a refusal is an operator who ACTED and was told no. They answer
 * different questions ("what are people stuck looking at" vs "what are people
 * being stopped from doing") and mixing them into one counter would make both
 * unreadable.
 */
export function recordWriteRefusal(e: {
  surface: DeadEndSurface;
  refusal: WriteRefusalKind;
  siteCode: string;
  userId: string;
  role: string;
  locale: string;
}): void {
  try {
    writeRefusals.inc({ surface: e.surface, refusal: e.refusal, site: e.siteCode });
  } catch {
    /* see recordDeadEnd */
  }
  try {
    log.info(
      {
        evt: 'floor.write_refusal',
        surface: e.surface,
        refusal: e.refusal,
        site: e.siteCode,
        user_id: e.userId,
        role: e.role,
        locale: e.locale,
      },
      `floor write refusal: ${e.surface}/${e.refusal}`,
    );
  } catch {
    /* observability is never load-bearing */
  }
}
