// ADR-0122 — the vocabulary the zero-live-controls detector reports in.
//
// It lives HERE, in `lib`, rather than beside the components, for one reason: the
// browser produces these values and the API route validates them, and a closed
// union restated in two files is a union that drifts. `stage-liveness.tsx` derives
// its prop types from these arrays; `api/operator/[site]/dead-end/route.ts`
// validates against the same arrays. One definition, two consumers, no
// hand-maintained second copy — the failure mode ADR-0091 names and that
// `ntfy-fallback-topics.yml` still lives with.
//
// Everything here is a `const` array, not a bare type, because the route needs
// them at RUNTIME. A `satisfies`-checked pair of "type plus restated array" would
// be the second copy again; deriving the type FROM the array cannot drift.

/**
 * The seven stages of the load workflow, as the operator would name them.
 *
 * Closed for the same reason `DeadEndSurface` is: it reaches a Loki label, and an
 * open string is how a label becomes a cardinality incident. It also makes adding
 * an eighth stage a compile error at the dispatch site rather than a silent hole
 * in the instrument that exists to find holes.
 */
export const STAGE_IDS = [
  'bol',
  'weight',
  'door',
  'decision',
  'stacks',
  'reject',
  'finish',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

/** Every control on a stage screen that can move the operator's work forward. */
export const STAGE_CONTROL_IDS = [
  // photo-input.tsx — shared by bol / weight / door / reject
  'photo_capture',
  'photo_add_another',
  'bol_continue',
  'weight_add',
  'weight_none',
  'weight_continue',
  'door_continue',
  'decision_begin_unload',
  'decision_reject',
  'stacks_pick_mode',
  'stacks_change_mode',
  'stacks_add',
  'stacks_finish',
  'reject_back',
  'reject_submit',
  'finish_add_concern',
  'finish_concern_cancel',
  'finish_concern_save',
  'finish_submit',
] as const;
export type StageControlId = (typeof STAGE_CONTROL_IDS)[number];

/**
 * Why a control is not live. `null` at a call site means it IS live.
 *
 * Named for the operator's situation, not the boolean that produced it — the same
 * rule `DeadEndState` follows: "the photo is already on the server" outlives
 * whichever `if` currently expresses it.
 */
export const STAGE_DISABLE_REASONS = [
  /** A Server Action is in flight. TRANSIENT. */
  'pending',
  /** A photo is being uploaded. TRANSIENT. */
  'uploading',
  /** ADR-0060 — nothing captured this mount and nothing on the server. */
  'no_photo',
  /** ADR-0109 — capture is withdrawn because the required photo already exists. */
  'photo_present',
  /** ADR-0109 — MAX_PHOTOS_PER_KIND reached. */
  'photo_limit',
  /** ADR-0109 — "add another" is offered only from `done` / `queued`. */
  'not_captured',
  /** The weight field is empty or outside 1–100,000. */
  'invalid_weight',
  /** The typed stack/total count is empty or below 1. */
  'invalid_count',
  /** No rejection / concern category picked yet. */
  'no_category',
  /** No live stack has been counted yet. */
  'no_stacks',
  /** The control is not rendered in this sub-state at all. */
  'not_rendered',
] as const;
export type StageDisableReason = (typeof STAGE_DISABLE_REASONS)[number];

/**
 * The reasons that resolve on their own.
 *
 * If ANY control is disabled for one of these, the screen is BUSY and the verdict
 * is withheld. Keeping this list short is the point: every reason added here is a
 * trap the detector agrees to stay quiet about. It is also the difference between
 * a signal and a pager that gets muted — every tap on this floor passes through
 * an all-disabled `pending` frame.
 */
export const TRANSIENT_DISABLE_REASONS: readonly StageDisableReason[] = ['pending', 'uploading'];

/**
 * The verdict, as a pure function.
 *
 * ONE definition, called by the React boundary and asserted by the suite. A copy
 * of the rule in the effect plus a copy in the test is the shape that makes a
 * coverage test vacuous — both sides transcribed, and a wrong rule agreeing with
 * itself.
 *
 * Three ways to NOT be a dead end, in order:
 *   - nothing registered      → UNMEASURED, not dead. Reporting a dead end here
 *     would fabricate the exact negative this module exists to detect.
 *   - some control live       → the thumb has somewhere to go.
 *   - some control transient  → busy, and waiting resolves it.
 */
export function isStageDeadEnd(
  entries: Iterable<readonly [StageControlId, StageDisableReason | null]>,
): boolean {
  const list = [...entries];
  if (list.length === 0) return false;
  if (list.some(([, reason]) => reason === null)) return false;
  if (list.some(([, reason]) => reason !== null && TRANSIENT_DISABLE_REASONS.includes(reason)))
    return false;
  return true;
}
