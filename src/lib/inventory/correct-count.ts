// ADR-0105 — a MANAGER corrects an operator's physical count, today or yesterday.
//
// ## What this is, in one line
//
// ADR-0084 gave the FLOOR a same-day self-void and deliberately gave the office
// nothing ("Letting managers void from the desktop too. Deliberately out of
// scope… adding a second desktop correction path before anyone has asked for one
// is inventing a mechanism to maintain"). Somebody has now asked. The path this
// retires is the one ADR-0094 named: a wrong count is a phone call to Bill and
// the right number written on paper beside the sheet.
//
// ## Why it is a CORRECTION and not a second void
//
// A void UN-SAYS a count; a re-activation OUT-VOTES one (ADR-0084 §"When to void,
// and when to re-activate"). Neither is what a manager holding the right number
// is doing. They are saying: **the count happened, and this is what it should
// have said.** So this writes the corrected value as the live anchor and RETAINS
// the prior one, which is the composition of the two mechanisms this repo already
// has rather than a third one:
//
//   1. the corrected value is a NEW `physical` snapshot at the ORIGINAL's
//      `snapshot_at` — ADR-0072's "recovery by appending", so no counted value is
//      ever erased or rewritten; and
//   2. the row it corrects is SOFT-VOIDED — ADR-0084's `voided_at`/`voided_by`,
//      so it drops out of anchor selection everywhere at once.
//
// Reusing `voided_at` rather than inventing a `superseded_at` is the load-bearing
// choice. ADR-0084 D2 found THIRTEEN anchor readers on this table and pinned them
// with `NOT_VOIDED` + a source-parsing guard test. A second, parallel
// "not-superseded" predicate would have to be added to all thirteen, and the
// omission failure mode of the new one is silent in exactly the way the old one
// was — the floor anchors on a number a manager has already replaced, and nothing
// reports it. This feature therefore adds ZERO new reader obligations: the moment
// the stamp lands, every reader that already honours ADR-0084 honours this too.
//
// The cost, stated rather than glossed: `voided_at` now carries two meanings —
// withdrawn (ADR-0084) and corrected-away (here). They are distinguished by the
// audit row's `reason`, never by the column, and the manager history endpoint is
// where a human reads that. That is a real loss of resolution at the column level
// and it buys thirteen readers that cannot be wrong.
//
// ## No approval gate. Bill's call.
//
// The manager types the right number and it is the right number. There is no
// second-signature step, no pending state, no ADR-0028-style four-eyes workflow.
// This is a deliberate departure from the bonus amendment path and from ADR-0066
// AP peer approval, and it is Bill's decision rather than an omission — recorded
// here so nobody "restores" a gate that was never removed.
//
// ## Two Pacific days, and why the second one is not a slippery slope
//
// ADR-0084 D4 refuses a prior-day void because the audience was a floor OPERATOR
// on a shared iPad and the office was the escape hatch. Here the caller IS the
// office, so the same reasoning does not bound the window at one day — but a
// window is still needed, because the further back a correction reaches the more
// it silently restates numbers that have already left the building (the EOD
// report is sent daily; the COR is filed monthly). Today + yesterday covers the
// real case — a count found wrong the next morning, which ADR-0084 explicitly
// left as "a phone call, not a tap" — and stops short of restating a day anybody
// has acted on. Two days back is refused, loudly, naming the window.
//
// ## The delta arithmetic, and the trap that made it necessary
//
// `reconciled_delta` is `physical − computed` at reconcile time (ADR-0037 D6) —
// the drift between what was counted and what the running balance predicted.
// A correction must keep the SAME computed baseline, because the claim it encodes
// is "the count was mis-keyed", not "the floor moved". So:
//
//     correctedDelta = originalDelta + (correctedTotal − originalTotal)
//
// which is exact: `originalDelta = originalTotal − computed`, therefore
// `originalDelta + correctedTotal − originalTotal = correctedTotal − computed`.
//
// **Calling `reconcilePhysicalCount` to re-derive it would be WRONG, and silently
// so.** That function computes `onHand(siteId, countedAt)`, whose anchor selector
// is `snapshot_at <= asOf` ordered `snapshot_at DESC, created_at DESC` — and the
// corrected row carries the ORIGINAL's `snapshot_at`, so the row being corrected
// ties on `snapshot_at` and wins the `created_at` tiebreak. Worse, `onHand` runs
// on the shared client and not on our transaction (documented in
// `reconcilePhysicalCount`'s own `tx` comment), so the soft-void we just stamped
// is invisible to it. The re-derived delta would therefore be measured against
// **the very number being corrected** — recording the size of the typo where the
// drift vs. the running balance belongs, on a column the C6 `physical_reconcile`
// audit finding reads. A legacy row with a NULL delta stays NULL: "we do not
// know" is true, and it is never backfilled (ADR-0078 Am.1's `uploaded_by`
// lesson).
//
// ## The audit is not a side effect of the write; it is a CONDITION of it
//
// Every gate in this repo that "audits in the same transaction" is one deleted
// line away from not doing so, and the deletion is green: the state change still
// lands, the tests about the state change still pass, and only the record is
// gone. So the audit here is READ BACK inside the transaction before it commits
// (`assertCorrectionAudited`), and a missing row aborts the whole thing — the
// void stamp and the corrected snapshot roll back with it. `auditWriter` is
// injectable for exactly one reason: so a test can supply a writer that writes
// nothing and prove the storage layer refuses, rather than asserting in prose
// that it would.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
import { withIdempotency } from '@/lib/idempotency';
import { pacificDayISO, pacificDayStartInstantPlus } from '@/lib/time';
import { NOT_VOIDED } from './snapshot-void';
import {
  PoolSplitMismatchError,
  snapshotTotalUnits,
  type PhysicalCountInput,
} from './running-balance';
import { SnapshotNotFoundError, SnapshotNotPhysicalError } from './void-count';

/**
 * The idempotency scope for a manager correction.
 *
 * NOT a `FloorScope`, and it must never be added to `FLOOR_SCOPES`. That list is
 * the server-side allowlist of writes `/api/queue/replay` may dispatch, and the
 * ADR-0084 D6 reasoning applies here with more force, not less: a correction both
 * removes an anchor AND writes a new one, addressed to one specific row by id.
 * Replayed from a stale offline queue it would restate a day the office has moved
 * on from. The desktop is online by definition.
 */
export const CORRECTION_SCOPE = 'manager.count.correct';

const TABLE = 'site_inventory_snapshots';

/** The `reason` both audit rows carry. One token, greppable, in one place. */
export const CORRECTION_REASON = 'manager_count_correction';

/**
 * The count named is already withdrawn (ADR-0084) or already corrected away.
 *
 * A 422 rather than a 404: the row exists and the caller is entitled to see it,
 * they are simply pointed at a row that is no longer the count. Correcting a
 * superseded row would fork the chain — two live snapshots claiming to correct
 * the same original — so it is refused and the caller is sent to the live one.
 */
export class SnapshotAlreadyVoidedError extends Error {
  readonly status = 422;
  readonly reason = 'snapshot_voided';
  constructor() {
    super('snapshot_voided');
    this.name = 'SnapshotAlreadyVoidedError';
  }
}

/**
 * Correcting a count to the value it already has.
 *
 * Refused rather than accepted as a no-op, and the distinction matters: a no-op
 * SUCCESS here would soft-void a perfectly good anchor and write a byte-identical
 * replacement, adding a link to the correction chain that records no correction.
 * ADR-0084 D7's already-voided short-circuit is a no-op success for the opposite
 * reason — there the caller asked for a state that already holds, so nothing needs
 * to happen. Here the caller is asking for a WRITE that would change nothing.
 */
export class CountCorrectionNoChangeError extends Error {
  readonly status = 422;
  readonly reason = 'no_change';
  constructor(readonly physicalTotal: number) {
    super('no_change');
    this.name = 'CountCorrectionNoChangeError';
  }
}

/**
 * ADR-0105 — the count is older than the current or previous PACIFIC day.
 *
 * Deliberately NOT `requires_amendment` (ADR-0084 D4 / ADR-0079 D4). That reason
 * means "a human with more authority than you must do this", and it names the
 * office as the route. The caller here IS the office; there is nobody to escalate
 * to. Reusing the token would send a manager to themselves, and would teach a
 * client to render an amendment affordance for a request no amendment workflow
 * accepts. The shape (an `error` string plus enough context to explain the
 * refusal) is kept; the token is honest.
 */
export class CountCorrectionOutsideWindowError extends Error {
  readonly status = 409;
  readonly error = 'outside_correction_window' as const;
  constructor(
    readonly snapshotId: string,
    readonly countedDayISO: string,
    readonly todayISO: string,
    readonly earliestCorrectableDayISO: string,
    readonly physicalTotal: number,
  ) {
    super('outside_correction_window');
    this.name = 'CountCorrectionOutsideWindowError';
  }

  toBody(): {
    error: 'outside_correction_window';
    snapshotId: string;
    countedDate: string;
    today: string;
    earliestCorrectableDate: string;
    physicalTotal: number;
    message: string;
  } {
    return {
      error: this.error,
      snapshotId: this.snapshotId,
      countedDate: this.countedDayISO,
      today: this.todayISO,
      earliestCorrectableDate: this.earliestCorrectableDayISO,
      physicalTotal: this.physicalTotal,
      message:
        `This count was taken on ${this.countedDayISO}. Corrections reach back to ` +
        `${this.earliestCorrectableDayISO} (yesterday) only — today is ${this.todayISO}. ` +
        `An older count is changed from /admin/inventory/anchors, which writes a new ` +
        `anchor and leaves the original count in the chain.`,
    };
  }
}

/**
 * Another request corrected this row between our read and our write.
 *
 * The `NOT_VOIDED`-guarded `updateMany` is the concurrency defence: exactly one of
 * two racing correctors matches a live row. The loser is an ERROR here, unlike
 * ADR-0084 D7's racing voids which resolve to a no-op success — because two voids
 * agree on the outcome (the count is gone) while two corrections do not (they
 * carry different numbers, and the loser's number is not on the record). Telling
 * the caller their value was not applied is the only honest answer.
 */
export class CountCorrectionConflictError extends Error {
  readonly status = 409;
  readonly error = 'already_corrected' as const;
  constructor(readonly snapshotId: string) {
    super('already_corrected');
    this.name = 'CountCorrectionConflictError';
  }
}

/**
 * The storage layer's refusal to leave a correction unrecorded.
 *
 * Thrown from INSIDE the transaction, so the void stamp and the corrected
 * snapshot roll back with it. Reaching this is a programming error, never a user
 * error — hence 500, and hence the message names the invariant rather than
 * apologising.
 */
export class CorrectionUnauditedError extends Error {
  readonly status = 500;
  readonly reason = 'correction_unaudited';
  constructor(missing: string) {
    super(
      `refusing to commit a count correction with no audit row (${missing}); ` +
        `the correction has been rolled back`,
    );
    this.name = 'CorrectionUnauditedError';
  }
}

/** The audit writer the correction transaction uses. Injectable so it can FAIL. */
export type CorrectionAuditWriter = (
  tx: Prisma.TransactionClient,
  row: Prisma.AuditLogUncheckedCreateInput,
) => Promise<void>;

const defaultAuditWriter: CorrectionAuditWriter = async (tx, row) => {
  await tx.auditLog.create({ data: row });
};

export interface CorrectPhysicalCountArgs {
  snapshotId: string;
  /** From the SESSION (`requireManagerForSite`), never from the payload. */
  actorUserId: string;
  /** From the SESSION. Site scoping, CLAUDE.md hard rule #2. */
  siteId: string;
  /** The value the count SHOULD have said. */
  corrected: PhysicalCountInput;
  /** ADR-0037 §3 pool split for the corrected count. */
  programUnits?: number | null;
  nonProgramUnits?: number | null;
  poolAttribution?: 'measured' | 'legacy';
  idempotencyKey?: string | null;
  /** Injectable clock. Production passes nothing; tests pin the instant. */
  now?: Date;
  /**
   * TEST SEAM ONLY. Production must never pass this. It exists so the
   * "unaudited write is refused" falsification can supply a writer that writes
   * nothing and observe the transaction abort.
   */
  auditWriter?: CorrectionAuditWriter;
}

export interface CorrectPhysicalCountResult {
  /** The row that was corrected — now soft-voided, values intact. */
  correctedFromSnapshotId: string;
  /** The new live anchor carrying the corrected value. */
  snapshotId: string;
  /** ISO-8601, not a `Date` — see `VoidSnapshotResult.voidedAt` for why. */
  correctedAt: string;
  fromPhysicalTotal: number;
  toPhysicalTotal: number;
  reconciledDelta: number | null;
  /** The operator whose entry this corrects, or null for a system-written row. */
  enteredByUserId: string | null;
  /** True when the corrector is not the person who entered the count. */
  crossOperator: boolean;
}

/**
 * The half-open [start, endExclusive) INSTANT window a manager may correct into:
 * the current Pacific day and the one before it.
 *
 * Built from `pacificDayStartInstantPlus` in BOTH directions rather than by
 * subtracting 86_400_000 from `currentPacificDayWindow().start`. That helper
 * steps the Pacific CALENDAR and is DST-correct in both directions; 24h
 * arithmetic is not, and the repo has already been bitten by exactly that (a
 * zero-width window on the 2026-11-01 fall-back day, measured — see the helper's
 * own doc comment). A correction window that collapses on one day a year, in a
 * path that restates a billing anchor, is not a cosmetic bug.
 */
export function pacificCorrectionWindow(instant: Date = new Date()): {
  start: Date;
  endExclusive: Date;
} {
  return {
    start: pacificDayStartInstantPlus(-1, instant),
    endExclusive: pacificDayStartInstantPlus(1, instant),
  };
}

function pooledEqual(a: Prisma.Decimal | null, b: number | null): boolean {
  if (a === null || b === null) return a === null && b === null;
  return a.equals(b);
}

/**
 * Correct a physical count taken today or yesterday (Pacific) at the caller's site.
 *
 * Gates, in order, ALL before anything is written:
 *
 *   1. Exists, and belongs to `siteId` — a snapshot id from another site is a
 *      **404, not a 403** (hard rule #2: Eugene and Woodland are separate MRC
 *      contracts; a 403 would confirm the id exists).
 *   2. Is a `physical` count. A `computed` marker is system-derived and has no
 *      counted value to correct.
 *   3. Is still live. An already-voided or already-corrected row is refused.
 *   4. Was counted on the current or previous PACIFIC day — never the device
 *      clock, never server-local (the container runs UTC, so a server-local
 *      "today" flips at 5 PM Pacific).
 *   5. The pool split, if `measured`, sums to the corrected total — the same
 *      ADR-0037 §3 rule `reconcilePhysicalCount` enforces, because a wrong split
 *      silently mis-bills MRC.
 *   6. The corrected value actually differs from the current one.
 *
 * Then, in ONE transaction: soft-void the original, write the corrected anchor,
 * write BOTH audit rows, and read them back before committing.
 */
export async function correctPhysicalCount(
  args: CorrectPhysicalCountArgs,
): Promise<CorrectPhysicalCountResult> {
  const now = args.now ?? new Date();

  // EVERY gate runs INSIDE the transaction, after the idempotency claim — which
  // is a deliberate departure from `voidSnapshot`, where the gates run first.
  //
  // The reason is specific to a correction and is not a style preference. A void
  // is idempotent against its own effect: replayed, its gates see a voided row
  // and ADR-0084 D7's short-circuit answers "already gone", which is the right
  // answer. A CORRECTION is not. Its own effect voids the row it names, so a
  // retry after a lost response — the exact case an idempotency key exists for —
  // would be refused `snapshot_voided` by gate 3 before `withIdempotency` ever
  // got to replay the stored answer. The manager would be told their correction
  // failed after it succeeded.
  //
  // Claiming first fixes that: a replay returns the stored body and never
  // re-executes a gate. A refusal still writes nothing — throwing inside the
  // transaction rolls the claim back with everything else, so a rejected request
  // does not burn its key.
  const outcome = await prisma.$transaction(
    (tx) =>
      withIdempotency(
        {
          key: args.idempotencyKey ?? null,
          scope: CORRECTION_SCOPE,
          actorUserId: args.actorUserId,
          siteId: args.siteId,
          payload: {
            snapshotId: args.snapshotId,
            units_indoor: args.corrected.units_indoor ?? null,
            units_total: args.corrected.units_total ?? null,
            units_in_processing: args.corrected.units_in_processing ?? 0,
            program_units: args.programUnits ?? null,
            non_program_units: args.nonProgramUnits ?? null,
          },
          tx,
          statusCode: 200,
        },
        () => gateAndCorrect(tx, args, now),
      ),
    { timeout: 20_000, maxWait: 10_000 },
  );

  return outcome.body as CorrectPhysicalCountResult;
}

/** Every gate, then the write — all on ONE transaction client. */
async function gateAndCorrect(
  tx: Prisma.TransactionClient,
  args: CorrectPhysicalCountArgs,
  now: Date,
): Promise<CorrectPhysicalCountResult> {
  const poolAttribution = args.poolAttribution ?? 'measured';

  const snapshot = await tx.siteInventorySnapshot.findUnique({
    // ADR-0084 D2 — `findUnique` accepts only unique fields, so `NOT_VOIDED`
    // cannot live in this where-clause. The compensating control is the
    // post-read `SnapshotAlreadyVoidedError` refusal below, which is stricter
    // than the filter would be: the filter would report "not found" and send the
    // manager hunting for a row that is sitting right there on their screen.
    // Allowlisted in `snapshot-void-readers.guard.test.ts` on that token.
    where: { id: args.snapshotId },
    select: {
      id: true,
      site_id: true,
      snapshot_kind: true,
      snapshot_at: true,
      units_indoor: true,
      units_total: true,
      units_in_processing: true,
      program_units: true,
      non_program_units: true,
      pool_attribution: true,
      reconciled_delta: true,
      voided_at: true,
    },
  });

  if (!snapshot || snapshot.site_id !== args.siteId) throw new SnapshotNotFoundError();
  if (snapshot.snapshot_kind !== 'physical') throw new SnapshotNotPhysicalError();
  if (snapshot.voided_at !== null) throw new SnapshotAlreadyVoidedError();

  const fromPhysicalTotal = snapshotTotalUnits(snapshot);
  const correctedInput = {
    units_indoor: args.corrected.units_indoor ?? null,
    units_total: args.corrected.units_total ?? null,
    units_in_processing: args.corrected.units_in_processing ?? 0,
  };
  const toPhysicalTotal = snapshotTotalUnits(correctedInput);

  // ── Today or yesterday, PACIFIC ──────────────────────────────────────────
  const { start, endExclusive } = pacificCorrectionWindow(now);
  if (snapshot.snapshot_at < start || snapshot.snapshot_at >= endExclusive) {
    throw new CountCorrectionOutsideWindowError(
      snapshot.id,
      pacificDayISO(snapshot.snapshot_at),
      pacificDayISO(now),
      pacificDayISO(start),
      fromPhysicalTotal,
    );
  }

  // ── ADR-0037 §3 — a measured split must sum to the corrected total ───────
  // Validated pre-transaction so a bad split persists nothing. Same refusal type
  // `reconcilePhysicalCount` throws, so the route's existing 422 branch covers it
  // without learning a second error class.
  const programUnits = args.programUnits ?? null;
  const nonProgramUnits = args.nonProgramUnits ?? null;
  if (poolAttribution === 'measured' && programUnits !== null && nonProgramUnits !== null) {
    const sum = programUnits + nonProgramUnits;
    if (sum !== toPhysicalTotal) {
      throw new PoolSplitMismatchError(
        'pool_mismatch',
        `program (${programUnits}) + non-program (${nonProgramUnits}) = ${sum}, ` +
          `which does not equal the corrected physical total ${toPhysicalTotal}`,
      );
    }
  }

  // ── Nothing to correct ───────────────────────────────────────────────────
  const unchanged =
    toPhysicalTotal === fromPhysicalTotal &&
    correctedInput.units_indoor === snapshot.units_indoor &&
    correctedInput.units_total === snapshot.units_total &&
    correctedInput.units_in_processing === snapshot.units_in_processing &&
    pooledEqual(snapshot.program_units, programUnits) &&
    pooledEqual(snapshot.non_program_units, nonProgramUnits) &&
    snapshot.pool_attribution === poolAttribution;
  if (unchanged) throw new CountCorrectionNoChangeError(fromPhysicalTotal);

  // ── Whose entry this corrects — ATTRIBUTION, never authorization ─────────
  // The original insert audit row, oldest first, exactly as `voidSnapshot` and
  // `eod-inventory.resolveCounter` resolve it. Snapshots carry no counter column
  // and none is added here: a denormalised copy is a second truth that can
  // disagree with the append-only record. NULL means "we do not know", which is
  // true for a system-written snapshot, and it is never backfilled.
  const entry = await tx.auditLog.findFirst({
    where: { table_name: TABLE, row_id: snapshot.id, action: 'insert' },
    orderBy: { created_at: 'asc' },
    select: { actor_user_id: true },
  });
  const enteredByUserId = entry?.actor_user_id ?? null;
  const crossOperator = enteredByUserId !== null && enteredByUserId !== args.actorUserId;

  // The corrected count keeps the ORIGINAL's baseline. See the header for why
  // re-deriving it through `onHand` would measure the typo instead of the drift.
  const reconciledDelta =
    snapshot.reconciled_delta === null
      ? null
      : snapshot.reconciled_delta + (toPhysicalTotal - fromPhysicalTotal);

  return applyCorrection(tx, {
    args,
    now,
    original: snapshot,
    correctedInput,
    fromPhysicalTotal,
    toPhysicalTotal,
    programUnits,
    nonProgramUnits,
    poolAttribution,
    reconciledDelta,
    enteredByUserId,
    crossOperator,
  });
}

interface CorrectionPlan {
  args: CorrectPhysicalCountArgs;
  now: Date;
  original: {
    id: string;
    site_id: string;
    snapshot_at: Date;
    units_indoor: number | null;
    units_total: number | null;
    units_in_processing: number;
    program_units: Prisma.Decimal | null;
    non_program_units: Prisma.Decimal | null;
    pool_attribution: string;
    reconciled_delta: number | null;
  };
  correctedInput: {
    units_indoor: number | null;
    units_total: number | null;
    units_in_processing: number;
  };
  fromPhysicalTotal: number;
  toPhysicalTotal: number;
  programUnits: number | null;
  nonProgramUnits: number | null;
  poolAttribution: 'measured' | 'legacy';
  reconciledDelta: number | null;
  enteredByUserId: string | null;
  crossOperator: boolean;
}

/**
 * The whole correction, on ONE transaction client: stamp, write, audit, VERIFY.
 *
 * The order is deliberate. The `NOT_VOIDED`-guarded `updateMany` runs FIRST and
 * is the concurrency gate — if it matches nothing, somebody else corrected this
 * row between our read and here, and we abort before writing a second live
 * anchor. Only then is the corrected snapshot created, so the two-live-anchors
 * state never exists even transiently within the transaction.
 */
async function applyCorrection(
  tx: Prisma.TransactionClient,
  plan: CorrectionPlan,
): Promise<CorrectPhysicalCountResult> {
  const { args, now, original } = plan;
  const writeAuditRow = args.auditWriter ?? defaultAuditWriter;

  // ADR-0120 — serialise against workbook promotion at this site, before the
  // void-then-insert pair. Taken first so it is the outermost lock on this path
  // and the row locks below are acquired after it, consistently with every other
  // writer.
  await lockSiteAgainstPromotion(tx, original.site_id);

  const { count } = await tx.siteInventorySnapshot.updateMany({
    where: { ...NOT_VOIDED, id: original.id },
    data: { voided_at: now, voided_by: args.actorUserId },
  });
  if (count === 0) throw new CountCorrectionConflictError(original.id);

  const created = await tx.siteInventorySnapshot.create({
    data: {
      site_id: original.site_id,
      // The ORIGINAL's instant, not `now`. This is what makes the correction an
      // edit IN PLACE: the count still belongs to the day it was taken, so every
      // day-keyed reader (the EOD block, the COR window, the flow bounds) sees
      // the corrected number on the same day the wrong one was on. Stamping
      // `now` would move a count of yesterday onto today and change which day's
      // flows are attributed to it.
      snapshot_at: original.snapshot_at,
      snapshot_kind: 'physical',
      source: 'manual',
      units_indoor: plan.correctedInput.units_indoor,
      units_total: plan.correctedInput.units_total,
      units_in_processing: plan.correctedInput.units_in_processing,
      reconciled_delta: plan.reconciledDelta,
      program_units: plan.programUnits,
      non_program_units: plan.nonProgramUnits,
      pool_attribution: plan.poolAttribution,
    },
    select: { id: true },
  });

  // ── Audit row A: the INSERT, on the new row ──────────────────────────────
  // Shaped like `reconcilePhysicalCount`'s insert row on purpose, so
  // `resolveCounter` and every other provenance reader keeps working against a
  // corrected snapshot instead of finding no insert row and reporting null.
  //
  // `actor_user_id` is the MANAGER, because they are who put this number on the
  // record — and the consequence is real and is recorded in ADR-0105: the daily
  // report's "counted by" line names the manager for a corrected count. The
  // operator who physically counted is carried in `counted_by` rather than
  // being silently substituted into the actor column, which would write a claim
  // that a person entered a number they did not enter.
  await writeAuditRow(tx, {
    actor_user_id: args.actorUserId,
    action: 'insert',
    table_name: TABLE,
    row_id: created.id,
    after: {
      snapshot_kind: 'physical',
      physical_total: plan.toPhysicalTotal,
      reconciled_delta: plan.reconciledDelta,
      program_units: plan.programUnits,
      non_program_units: plan.nonProgramUnits,
      pool_attribution: plan.poolAttribution,
      corrected_from: original.id,
      counted_by: plan.enteredByUserId,
      reason: CORRECTION_REASON,
    },
  });

  // ── Audit row B: the UPDATE, on the row that was corrected ───────────────
  // WHO (`actor_user_id` + `after.corrected_by`), WHEN (`created_at` +
  // `after.voided_at`), FROM (`before.physical_total` and every counted column)
  // and TO (`after.physical_total`, `after.corrected_to`). `entered_by` ties it
  // to the operator's original entry. This row is the correction's record; the
  // `corrected_to`/`corrected_from` pair is what makes a chain of corrections
  // traversable in either direction.
  await writeAuditRow(tx, {
    actor_user_id: args.actorUserId,
    action: 'update',
    table_name: TABLE,
    row_id: original.id,
    before: {
      units_indoor: original.units_indoor,
      units_total: original.units_total,
      units_in_processing: original.units_in_processing,
      program_units: original.program_units?.toString() ?? null,
      non_program_units: original.non_program_units?.toString() ?? null,
      pool_attribution: original.pool_attribution,
      reconciled_delta: original.reconciled_delta,
      physical_total: plan.fromPhysicalTotal,
      voided_at: null,
      voided_by: null,
    },
    after: {
      units_indoor: plan.correctedInput.units_indoor,
      units_total: plan.correctedInput.units_total,
      units_in_processing: plan.correctedInput.units_in_processing,
      program_units: plan.programUnits,
      non_program_units: plan.nonProgramUnits,
      pool_attribution: plan.poolAttribution,
      reconciled_delta: plan.reconciledDelta,
      physical_total: plan.toPhysicalTotal,
      voided_at: now.toISOString(),
      voided_by: args.actorUserId,
      corrected_to: created.id,
      corrected_by: args.actorUserId,
      entered_by: plan.enteredByUserId,
      cross_operator: plan.crossOperator,
      reason: CORRECTION_REASON,
    },
  });

  await assertCorrectionAudited(tx, original.id, created.id);

  return {
    correctedFromSnapshotId: original.id,
    snapshotId: created.id,
    correctedAt: now.toISOString(),
    fromPhysicalTotal: plan.fromPhysicalTotal,
    toPhysicalTotal: plan.toPhysicalTotal,
    reconciledDelta: plan.reconciledDelta,
    enteredByUserId: plan.enteredByUserId,
    crossOperator: plan.crossOperator,
  };
}

/**
 * Refuse to commit a correction whose audit rows are not there.
 *
 * Read back on the SAME transaction client, so it sees the uncommitted rows this
 * transaction just wrote and nothing else. Throwing aborts the transaction, which
 * takes the void stamp and the corrected snapshot with it — that is the whole
 * point: the failure mode of a missing audit row is "the correction did not
 * happen", never "the correction happened quietly".
 *
 * This is not belt-and-braces around a write that cannot fail. It is the only
 * thing standing between this module and the failure that recurs across this
 * codebase: an audit call is deleted or refactored out, the state change still
 * lands, every test about the state change still passes, and the record is gone.
 */
async function assertCorrectionAudited(
  tx: Prisma.TransactionClient,
  originalId: string,
  createdId: string,
): Promise<void> {
  const rows = await tx.auditLog.findMany({
    where: { table_name: TABLE, row_id: { in: [originalId, createdId] } },
    select: { row_id: true, action: true },
  });
  const missing: string[] = [];
  if (!rows.some((r) => r.row_id === createdId && r.action === 'insert')) {
    missing.push(`insert row for ${createdId}`);
  }
  if (!rows.some((r) => r.row_id === originalId && r.action === 'update')) {
    missing.push(`update row for ${originalId}`);
  }
  if (missing.length > 0) throw new CorrectionUnauditedError(missing.join(' + '));
}

export interface WindowCountRow {
  id: string;
  countedDayISO: string;
  enteredAt: Date;
  physicalTotal: number;
  units_indoor: number | null;
  units_total: number | null;
  units_in_processing: number;
  /** The operator who entered it, or null when no insert audit row exists. */
  enteredByUserId: string | null;
  /** True when this row is itself the product of an earlier correction. */
  isCorrection: boolean;
  /** The row this one corrected, when it is a correction. */
  correctedFromId: string | null;
  /** The row that superseded this one, when it has been corrected away. */
  correctedToId: string | null;
  /** Set when this row is no longer live — withdrawn OR corrected away. */
  voidedAt: Date | null;
  /** Who withdrew or corrected it. */
  voidedByUserId: string | null;
  /**
   * Why it is not live. `corrected` = superseded by ADR-0105; `withdrawn` = an
   * ADR-0084 void. The COLUMN cannot tell these apart by design (D1) — the audit
   * row's `reason` is the only thing that can, so it is resolved here once rather
   * than guessed at by every reader.
   */
  voidReason: 'corrected' | 'withdrawn' | null;
  /** True when the service would accept a correction for this row right now. */
  correctable: boolean;
}

/**
 * Every physical count at a site from today and yesterday (Pacific) — live AND
 * superseded — with the correction chain attached.
 *
 * **Deliberately NOT filtered by `NOT_VOIDED`, and allowlisted as such in
 * `snapshot-void-readers.guard.test.ts`.** This is a HISTORY, not an anchor
 * selector: nothing is computed from what it returns. Dropping the superseded
 * rows would reproduce exactly the problem soft-voiding exists to avoid — the
 * number the floor entered vanishes, and the manager looking at a corrected count
 * cannot see what it was corrected from. The same reasoning ADR-0084 D3 applied
 * to `/admin/inventory/anchors` and the manager snapshot list.
 *
 * The void state is SURFACED instead, and `correctable` is computed here from the
 * same predicate the service gates on, so the screen and the service agree by
 * construction: the screen cannot offer a Correct affordance on a row the service
 * would then refuse.
 *
 * Names are NOT resolved here. The service stays a pure inventory concern with no
 * `users` dependency — the page resolves ids to names, exactly as ADR-0084 Am.1
 * decided for the iPad void list.
 */
export async function listWindowCountsAtSite(
  siteId: string,
  now: Date = new Date(),
): Promise<WindowCountRow[]> {
  const { start, endExclusive } = pacificCorrectionWindow(now);
  const rows = await prisma.siteInventorySnapshot.findMany({
    where: {
      site_id: siteId,
      snapshot_kind: 'physical',
      snapshot_at: { gte: start, lt: endExclusive },
    },
    orderBy: [{ snapshot_at: 'desc' }, { created_at: 'desc' }],
    select: {
      id: true,
      snapshot_at: true,
      // `created_at`, not `snapshot_at`, is the instant a human can tell two of
      // the day's counts apart by — `snapshot_at` is Pacific midnight of the
      // counted day (ADR-0060 D-3), so it renders every count as "12:00 AM".
      created_at: true,
      units_indoor: true,
      units_total: true,
      units_in_processing: true,
      voided_at: true,
      voided_by: true,
    },
  });
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const audit = await prisma.auditLog.findMany({
    where: { table_name: TABLE, row_id: { in: ids } },
    orderBy: { created_at: 'asc' },
    select: { row_id: true, action: true, actor_user_id: true, after: true },
  });

  interface Payload {
    corrected_from?: unknown;
    corrected_to?: unknown;
    reason?: unknown;
  }
  const firstInsert = new Map<string, { actor: string | null; after: Payload }>();
  const lastUpdate = new Map<string, Payload>();
  for (const a of audit) {
    const after = (a.after ?? {}) as Payload;
    if (a.action === 'insert') {
      // First insert row wins, matching the service's `orderBy created_at asc`.
      if (!firstInsert.has(a.row_id)) firstInsert.set(a.row_id, { actor: a.actor_user_id, after });
    } else if (a.action === 'update') {
      lastUpdate.set(a.row_id, after);
    }
  }

  return rows.map((r) => {
    const ins = firstInsert.get(r.id);
    const upd = lastUpdate.get(r.id);
    const correctedFromId =
      typeof ins?.after.corrected_from === 'string' ? ins.after.corrected_from : null;
    const correctedToId = typeof upd?.corrected_to === 'string' ? upd.corrected_to : null;
    return {
      id: r.id,
      countedDayISO: pacificDayISO(r.snapshot_at),
      enteredAt: r.created_at,
      physicalTotal: snapshotTotalUnits(r),
      units_indoor: r.units_indoor,
      units_total: r.units_total,
      units_in_processing: r.units_in_processing,
      enteredByUserId: ins?.actor ?? null,
      isCorrection: correctedFromId !== null,
      correctedFromId,
      correctedToId,
      voidedAt: r.voided_at,
      voidedByUserId: r.voided_by,
      // A superseded row names its successor; a withdrawn one does not. Reported
      // from the record rather than inferred from the column, which cannot say.
      voidReason: r.voided_at === null ? null : correctedToId !== null ? 'corrected' : 'withdrawn',
      correctable: r.voided_at === null,
    };
  });
}
