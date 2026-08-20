// ADR-0124 — which stage a load is on, decided from SERVER FACTS alone.
//
// ## The defect this removes
//
// ADR-0121: "Move the stage off `bolDone` onto a server-derived stage. The right
// shape, and where this should go — but it changes how every stage is selected,
// which is not a change to make at 1 PM with trucks on the dock."
//
// `load-workflow.tsx` selected the stage from `load.status` PLUS two client
// `useState` latches:
//
//   - `bolDone` — set when the operator taps Continue on stage 1. Taking the BOL
//     photo does not move `load.status` (it stays `arrived`), and
//     `recordBolCapture`'s entire body is `await assertOwn(args)` — it writes
//     NOTHING. So the only record that stage 1 was finished lived in one browser
//     tab, and any reload or takeover returned to stage 1.
//   - `weightSkipped` — set when the operator taps "None". `recordWeightSkip`
//     also writes nothing, under a comment reading "no DB change needed; the
//     weight stage gates only on the user's choice". The choice died with the
//     tab.
//
// On 2026-08-20 the first of those put three operators in turn onto a BOL screen
// for a load whose BOL photo was already in Postgres. #286 made that screen
// escapable; this makes it stop happening.
//
// ## The facts it reads, and why those
//
//   - **BOL done ⟺ `photo_counts.bol > 0`.** The photo row IS the completion —
//     it is what ADR-0060 forces, it is written by `/api/photos/confirm` before
//     the stage action fires, and it was ALREADY plumbed to this component for
//     ADR-0109. Nothing new is threaded and no column is added. A separate
//     `bol_captured_at` was considered and rejected below.
//   - **Weight decided ⟺ `weight_captured_at`/status (the "Add" path) OR the new
//     `weight_skipped_at` (the "None" path).** The skip needed a fact because it
//     is the one decision on this flow that leaves no other trace: no photo, no
//     status move, no weight.
//
// ## Pure, and separate from React
//
// It takes a plain record and returns a string, so the whole dispatch matrix is
// exercisable without mounting anything — and the composition test can mount the
// real workflow and check that what RENDERS agrees with what this function says.
// A dispatch expressed only as nested ternaries inside a component is one that
// can only be tested through the DOM, which is how a seam goes unexamined.

import type { LoadStatus } from '@prisma/client';
import type { StageId } from '@/lib/floor/stage-controls';

/**
 * Everything the dispatch reads. Every field is a SERVER fact.
 *
 * There is deliberately no room for a client hint. A latch that could only ever
 * move the stage forward would be safe, and would also be a second answer to a
 * question that already has one — which is the shape ADR-0091 rules out and the
 * shape that produced the 2026-08-20 incident.
 */
export interface StageFacts {
  status: LoadStatus;
  /** `photo_counts.bol` — how many BOL photos the load already holds. */
  bolPhotoCount: number;
  /** `inbound_loads.weight_skipped_at !== null` — the operator declared no ticket. */
  weightSkipped: boolean;
}

/**
 * The statuses at which an operator is still WORKING the load.
 *
 * Restated here rather than imported from `open-loads.ts`, which sits beside
 * `prisma` and cannot enter the browser bundle — the identical constraint
 * `consumed-slot.ts` documents and `load-workflow.tsx` already lived with.
 */
export const WORKING_STATUSES: readonly LoadStatus[] = [
  'arrived',
  'weight_captured',
  'unload_started',
  'in_progress',
  'finished',
] as const;

/**
 * The stage to render, or `null` when the load is not on a working status at all
 * (`voided`, `verified`, `submitted_to_mymrc`, `processed` — the branch that
 * renders the closed-load card and its Link).
 *
 * `reject` is NOT produced here. It is a sub-screen of `decision` entered by a
 * control and left by one, with no server fact of its own until the rejection
 * commits; the workflow shell still owns that toggle.
 */
export function selectStage(facts: StageFacts): StageId | null {
  if (!WORKING_STATUSES.includes(facts.status)) return null;

  if (facts.status === 'arrived') {
    // ADR-0060 leads, and it leads for a reason: a load must not reach the dock
    // timer without its paperwork. This ordering also means a load whose BOL
    // photo is somehow absent goes BACK to stage 1 rather than forward past it.
    if (facts.bolPhotoCount === 0) return 'bol';
    // `arrived` with a BOL photo and no weight decision is the weight stage. The
    // "Add" path leaves `arrived` for `weight_captured` and is caught below; the
    // "None" path stays on `arrived`, which is why it needs its own fact.
    if (!facts.weightSkipped) return 'weight';
    return 'door';
  }

  if (facts.status === 'weight_captured') return 'door';
  if (facts.status === 'unload_started') return 'decision';
  if (facts.status === 'in_progress') return 'stacks';
  return 'finish'; // 'finished'
}
