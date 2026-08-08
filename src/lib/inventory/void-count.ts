// ADR-0084 — same-day operator VOID of a physical inventory count.
//
// JT: "if we accidentally entered the count twice, we should be able to remove
// one." Bill: same-day only on the iPad; prior day is an office job.
//
// ## Amendment 1 (2026-08-08) — the gate is SITE-scoped, not OWNER-scoped
//
// Bill, asked to pick between owner-only / site / site-with-manager-confirm:
// **"Widen to site."**
//
// This module used to refuse with 403 `not_your_count` unless the caller was the
// operator named on the count's original insert audit row. Floor iPads are
// SHARED kiosks with per-operator PIN sign-in, so a duplicate keyed at 14:00 by
// the day operator could not be withdrawn by whoever PIN'd in at 15:00 — and
// because a void is same-day only, there was no next-day path either. The
// mistyped anchor simply stood overnight and became an office job.
//
// **The trade, stated plainly rather than described as a refactor: the gate
// loosened from owner to site; attribution went from one id to two.**
//
//   - GIVEN UP: an operator can now withdraw any same-day count at their own
//     site, not only one they entered.
//   - GAINED: the mistake is correctable on the shift that made it, by whoever
//     is actually standing at the iPad.
//   - ALSO GAINED: the audit row now carries BOTH ids — `actor_user_id` is who
//     withdrew it, `after.entered_by` is who entered it — so the history shows
//     who withdrew whose count. Before this, a void recorded the withdrawer
//     only, because the gate guaranteed they were the same person.
//
// This is the ADR-0078 Amendment 1 move applied to a second surface, and the
// asymmetry with it was the reason this one waited for Bill: a photo upload is
// ADDITIVE, a void is DESTRUCTIVE — it withdraws the anchor the whole floor is
// computed from. So the risk that justified Am.1 did not automatically carry
// over, and this was not loosened unilaterally.
//
// Unchanged, and NOT to be "restored":
//
//   - Cross-SITE is still refused, still as a 404 rather than a 403 (hard rule
//     #2; Eugene and Woodland are separate MRC contracts in separate
//     jurisdictions). Pinned by `a snapshot from another site is a 404`.
//   - Same-day only, in PACIFIC, from `currentPacificDayWindow`.
//   - The confirm step, the soft void, the online-only rule, and every reader
//     filter in `snapshot-void.ts`.
//
// ## What this is NOT
//
// It is not a delete. `voided_at` is stamped and the row stays, because the row
// is the only record of a number a human physically counted and that the system
// may already have reported to MRC. See the migration header for the full
// reasoning, and `snapshot-void.ts` for how every reader is kept honest.
//
// It is not the bonus amendment workflow, and it must never be wired into one —
// see `SnapshotVoidAmendmentRequiredError` below.
//
// It is not an offline-queueable write. See "Why this is online-only".
//
// ## Why this is online-only (ADR-0084 D5)
//
// `FLOOR_SCOPES` in `src/lib/operator/floor-writes.ts` is the server-side
// allowlist of writes the offline queue may replay, and this scope is
// deliberately absent from it. A queued entry naming `operator.count.void` is
// answered 400 `unknown_scope` — the refusal is structural, not a client-side
// convention, so a hand-edited IndexedDB row cannot reach this service either.
//
// The reason is contention, not caution. Every other floor write ADDS a fact:
// replayed late, an inbound confirm or a stack count is still the same fact and
// converges. A void REMOVES the anchor the whole floor is computed from, and it
// is addressed to ONE SPECIFIC ROW by id. Between the tap and the replay the
// office can amend, a manager can release a held count, `reconcilePhysicalCount`
// can write a newer anchor, or the day can roll over — and the day-pin would
// then refuse the entry anyway (a void is same-day only, so a queued void is
// almost by definition a stale one). Queuing it would mean an operator's iPad
// silently retracting an anchor hours after the floor moved on, which is a
// larger version of exactly the defect this ADR is closing.
//
// So the affordance is simply unavailable offline. The operator's count is never
// at risk — it is already saved; only the withdrawal has to wait for a
// connection, and the office path exists for everything else.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withIdempotency } from '@/lib/idempotency';
import { currentPacificDayWindow, pacificDayISO } from '@/lib/time';
import { NOT_VOIDED } from './snapshot-void';

/** The idempotency scope for a void. NOT a `FloorScope` — see the header. */
export const VOID_SCOPE = 'operator.count.void';

const TABLE = 'site_inventory_snapshots';

/** The snapshot named does not exist, or is not this site's. */
export class SnapshotNotFoundError extends Error {
  readonly status = 404;
  readonly reason = 'snapshot_not_found';
  constructor() {
    super('snapshot_not_found');
    this.name = 'SnapshotNotFoundError';
  }
}

/** Only a `physical` count is a floor count an operator can withdraw. */
export class SnapshotNotPhysicalError extends Error {
  readonly status = 422;
  readonly reason = 'not_a_physical_count';
  constructor() {
    super('not_a_physical_count');
    this.name = 'SnapshotNotPhysicalError';
  }
}

// ADR-0084 Amendment 1 (2026-08-08) — `SnapshotNotYoursError` / the
// `not_your_count` 403 was DELETED, not disabled. The void is site-scoped now:
// any activated operator at the count's own site may withdraw a SAME-DAY count,
// and the audit row names both the withdrawer and the original enterer. Leaving
// a dead error class here would read as a check someone forgot to call and
// invite its restoration — which is the shared-iPad defect the amendment closes.
// See `voidSnapshot`'s doc comment and ADR-0084 Amendment 1.

/**
 * ADR-0084 D4 — a PRIOR-day void is refused, and says where to go instead.
 *
 * ## This is NOT the bonus amendment workflow. Do not wire it into one.
 *
 * The SHAPE is borrowed on purpose — `error: 'requires_amendment'` plus context,
 * exactly as `DailyThroughputAmendmentRequiredError` (ADR-0079 D4) borrowed it —
 * so a client that already knows how to render "this needs the office" renders
 * this too, and so an eventual generalisation is a swap rather than a rewrite.
 *
 * The PATH is separate, and structurally must be. `resolveAmendmentApprover`
 * sources its approver from `bonus_signature_chains` and throws
 * `AmendmentWorkflowForbiddenError` for any requester who is not a bonus payroll
 * signer. A floor operator is never one. Routing a floor operator's mistyped
 * count into that workflow would hand the exact audience this feature exists for
 * a 403 they could do nothing about — and would file an inventory correction as
 * a payroll amendment, which is a category error in an audit trail that is meant
 * to explain itself years later.
 *
 * So this REFUSES, visibly, naming the office as the route. Nothing is written.
 */
export class SnapshotVoidAmendmentRequiredError extends Error {
  readonly status = 409;
  readonly error = 'requires_amendment' as const;
  constructor(
    readonly snapshotId: string,
    readonly countedDayISO: string,
    readonly todayISO: string,
    readonly physicalTotal: number,
  ) {
    super('requires_amendment');
    this.name = 'SnapshotVoidAmendmentRequiredError';
  }

  /** The 409 body. Mirrors the bonus + ADR-0079 D4 shape (`error` + context). */
  toBody(): {
    error: 'requires_amendment';
    snapshotId: string;
    countedDate: string;
    today: string;
    physicalTotal: number;
  } {
    return {
      error: this.error,
      snapshotId: this.snapshotId,
      countedDate: this.countedDayISO,
      today: this.todayISO,
      physicalTotal: this.physicalTotal,
    };
  }
}

export interface VoidSnapshotArgs {
  snapshotId: string;
  /** From the SESSION (`requireActivatedOperator`), never from the payload. */
  actorUserId: string;
  /** From the SESSION. Site scoping, CLAUDE.md hard rule #2. */
  siteId: string;
  /** Client-minted idempotency key, or null to opt out. */
  idempotencyKey?: string | null;
  /** Injectable clock. Production passes nothing; tests pin the instant. */
  now?: Date;
}

export interface VoidSnapshotResult {
  snapshotId: string;
  /**
   * ISO-8601 instant, NOT a `Date`.
   *
   * Deliberate, and load-bearing. `withIdempotency` stores this whole object as
   * JSONB and hands the STORED copy back on a replay, so a `Date` here would be
   * a `Date` on the first call and an ISO string on every replay — a type the
   * compiler believes and the runtime contradicts, surfacing as
   * `result.voidedAt.toISOString is not a function` on exactly the retry path
   * this feature exists to make safe. Serialisable end to end instead.
   */
  voidedAt: string;
  /** True when the row was ALREADY voided and this call changed nothing. */
  alreadyVoided: boolean;
  /** The withdrawn count's total, so the UI can name what it removed. */
  physicalTotal: number;
  /**
   * ADR-0084 Amendment 1 — the operator who ENTERED the count, resolved from the
   * append-only insert audit row, or null when that row is missing (a snapshot
   * written by a system path rather than a floor operator).
   *
   * NEVER conflate this with `actorUserId`. It is attribution, not authorization:
   * since Amendment 1 it no longer decides anything, it is only RECORDED. Same
   * distinction ADR-0078 Am.1 drew between `loadOwnerUserId` and `actorUserId` —
   * stamping one as the other writes a claim that a person did something they
   * did not do, into a table that can never take it back (hard rule #6).
   */
  enteredByUserId: string | null;
  /** True when the withdrawer is not the operator who entered the count. */
  crossOperator: boolean;
}

function totalOf(row: {
  units_indoor: number | null;
  units_total: number | null;
  units_in_processing: number;
}): number {
  return (row.units_total ?? row.units_indoor ?? 0) + row.units_in_processing;
}

/**
 * Withdraw a physical count taken TODAY (Pacific) at the caller's own site.
 *
 * Gates, in order, all before anything is written:
 *
 *   1. Exists, and belongs to `siteId` (hard rule #2 — a snapshot id from
 *      another site is a 404, not a 403: the caller learns nothing). Since
 *      Amendment 1 this is the ONLY authorization check, deliberately.
 *   2. Is a `physical` count. `computed` markers are system-derived.
 *   3. Was counted on the CURRENT PACIFIC day — never the device clock, never
 *      server-local. The container runs UTC, so a server-local "today" flips at
 *      5 PM Pacific and would start refusing an evening-shift operator's real
 *      day while accepting tomorrow's.
 *
 * There is no fourth gate any more. The original enterer is still resolved from
 * the append-only `audit_logs` insert row (the same provenance path
 * `eod-inventory.resolveCounter` uses) — but to be RECORDED, not to decide.
 *
 * Then: stamp + audit in ONE transaction (hard rule #6), idempotently.
 */
export async function voidSnapshot(args: VoidSnapshotArgs): Promise<VoidSnapshotResult> {
  const now = args.now ?? new Date();

  const snapshot = await prisma.siteInventorySnapshot.findUnique({
    where: { id: args.snapshotId },
    select: {
      id: true,
      site_id: true,
      snapshot_kind: true,
      snapshot_at: true,
      units_indoor: true,
      units_total: true,
      units_in_processing: true,
      voided_at: true,
    },
  });

  // Site scoping folded into existence: a wrong-site id is indistinguishable
  // from a nonexistent one, so this cannot be used to probe another site's ids.
  if (!snapshot || snapshot.site_id !== args.siteId) throw new SnapshotNotFoundError();
  if (snapshot.snapshot_kind !== 'physical') throw new SnapshotNotPhysicalError();

  const physicalTotal = totalOf(snapshot);

  // ── Same-day, Pacific ────────────────────────────────────────────────────
  // Against `currentPacificDayWindow`, the canonical half-open instant window
  // (ADR-0065) — the same helper the floor queue and billing generation key on,
  // so "today" here is byte-identical to "today" everywhere else. Compared as
  // INSTANTS because `snapshot_at` is an instant column: counts are stored at
  // Pacific midnight of their day (ADR-0060 D-3), so a count taken today sits
  // exactly on `start` and is inside `[start, endExclusive)`.
  const { start, endExclusive } = currentPacificDayWindow(now);
  const countedAt = snapshot.snapshot_at;
  if (countedAt < start || countedAt >= endExclusive) {
    throw new SnapshotVoidAmendmentRequiredError(
      snapshot.id,
      pacificDayISO(countedAt),
      pacificDayISO(now),
      physicalTotal,
    );
  }

  // ── Who entered it — ATTRIBUTION, not authorization (Amendment 1) ────────
  // Resolved from the audit row `reconcilePhysicalCount` wrote in the same
  // transaction as the insert; snapshots carry no counter column, and adding one
  // would create a second truth that could disagree with the append-only record.
  //
  // `findFirst` + `orderBy created_at asc`: the ORIGINAL insert row, matching
  // `resolveCounter`. A later audit row on the same snapshot (a previous void, an
  // anchor reactivation note) must never be mistaken for the entry.
  //
  // Before Amendment 1 this read decided the request (403 `not_your_count`). It
  // now decides nothing — the value is written into the void's audit row so a
  // cross-operator withdrawal is a recorded fact rather than an inference from
  // two rows nobody will join. NULL when there is no insert row at all (a
  // system-written snapshot); that is "we do not know", which is true, and it is
  // never backfilled from anything else (ADR-0078 Am.1's `uploaded_by` lesson).
  const entry = await prisma.auditLog.findFirst({
    where: { table_name: TABLE, row_id: snapshot.id, action: 'insert' },
    orderBy: { created_at: 'asc' },
    select: { actor_user_id: true },
  });
  const enteredByUserId = entry?.actor_user_id ?? null;
  const crossOperator = enteredByUserId !== null && enteredByUserId !== args.actorUserId;

  // ── Idempotent double-tap ────────────────────────────────────────────────
  // Two defences, because they cover different taps.
  //
  // `withIdempotency` covers the SAME submission arriving twice (double-tap,
  // retry after a lost response): the second call replays the stored response
  // and runs no write. Claim and write share one transaction, per ADR-0078.
  //
  // The `alreadyVoided` short-circuit covers a DIFFERENT submission that names
  // an already-voided row — a fresh key from a second device, or a stale screen.
  // It is a no-op SUCCESS rather than an error: the operator asked for the count
  // to be gone and it is gone, and a 409 here would only teach them to worry
  // about a state that is already correct. Critically it writes NO second audit
  // row — an append-only log that accumulates one entry per redundant tap stops
  // being a record of what happened.
  if (snapshot.voided_at !== null) {
    return {
      snapshotId: snapshot.id,
      voidedAt: snapshot.voided_at.toISOString(),
      alreadyVoided: true,
      physicalTotal,
      enteredByUserId,
      crossOperator,
    };
  }

  const outcome = await prisma.$transaction(
    (tx) =>
      withIdempotency(
        {
          key: args.idempotencyKey ?? null,
          scope: VOID_SCOPE,
          actorUserId: args.actorUserId,
          siteId: args.siteId,
          payload: { snapshotId: snapshot.id },
          tx,
          statusCode: 200,
        },
        async () =>
          voidWrite(tx, snapshot.id, args, now, physicalTotal, enteredByUserId, crossOperator),
      ),
    { timeout: 20_000, maxWait: 10_000 },
  );

  return outcome.body as VoidSnapshotResult;
}

/**
 * The stamp + its audit row, on ONE transaction client.
 *
 * The `updateMany` is guarded by `NOT_VOIDED`, so it is also the concurrency
 * defence: two requests racing past the read above both reach here, and exactly
 * one matches. `count === 0` means the other one won — reported as
 * `alreadyVoided` rather than as an error, and with no audit row written, which
 * is the same answer the short-circuit above gives.
 */
async function voidWrite(
  tx: Prisma.TransactionClient,
  snapshotId: string,
  args: VoidSnapshotArgs,
  now: Date,
  physicalTotal: number,
  enteredByUserId: string | null,
  crossOperator: boolean,
): Promise<VoidSnapshotResult> {
  const { count } = await tx.siteInventorySnapshot.updateMany({
    where: { ...NOT_VOIDED, id: snapshotId },
    data: { voided_at: now, voided_by: args.actorUserId },
  });
  if (count === 0) {
    const row = await tx.siteInventorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
      select: { voided_at: true },
    });
    return {
      snapshotId,
      voidedAt: (row.voided_at ?? now).toISOString(),
      alreadyVoided: true,
      physicalTotal,
      enteredByUserId,
      crossOperator,
    };
  }

  // CLAUDE.md hard rule #6 — audited in the SAME transaction as the write it
  // describes, so an audit row can never exist for a void that rolled back, nor
  // a void exist unrecorded. `action: 'update'` because the row is amended, not
  // inserted or removed; `before`/`after` carry the void columns so the entry
  // reads as the state change it is.
  await tx.auditLog.create({
    data: {
      actor_user_id: args.actorUserId,
      action: 'update',
      table_name: TABLE,
      row_id: snapshotId,
      before: { voided_at: null, voided_by: null },
      after: {
        voided_at: now.toISOString(),
        voided_by: args.actorUserId,
        // ADR-0084 Amendment 1 — BOTH ids, always, on every void. `actor_user_id`
        // above is the withdrawer; these two say whose count it was. Written
        // unconditionally rather than only on the cross-operator case: an
        // absent field would be ambiguous between "the same person" and "an
        // older build that did not record it", and the history is read years
        // later by someone who has neither this file nor the deploy dates.
        entered_by: enteredByUserId,
        cross_operator: crossOperator,
        physical_total: physicalTotal,
        reason: 'operator_same_day_void',
      },
    },
  });

  return {
    snapshotId,
    voidedAt: now.toISOString(),
    alreadyVoided: false,
    physicalTotal,
    enteredByUserId,
    crossOperator,
  };
}

export interface VoidableCountRow {
  id: string;
  enteredAt: Date;
  physicalTotal: number;
  /** The operator who entered it, or null when no insert audit row exists. */
  enteredByUserId: string | null;
  /** True when `actorUserId` entered it — drives "yours" vs "theirs" labelling. */
  isMine: boolean;
}

/**
 * Today's (Pacific) live physical counts AT A SITE — the set the iPad may offer
 * to void.
 *
 * ADR-0084 Amendment 1 — this used to filter to the counts the caller had
 * entered and was named `listTodaysVoidableCounts`. It was RENAMED along with
 * the behaviour, on the ADR-0078 Am.1 precedent: left under the old name, the
 * next reader would reasonably conclude the missing ownership filter was an
 * oversight and put it back, reintroducing the shared-iPad defect.
 *
 * `actorUserId` is still taken — but only to mark each row `isMine`, so the
 * screen can say whose count it is before asking to withdraw it. It no longer
 * filters anything.
 *
 * Voided rows are excluded (`NOT_VOIDED`): the screen offers an ACTION, and a
 * withdrawn count is not actionable. The recovery surfaces are where a voided
 * count stays visible.
 *
 * The list and the service agree by construction: both accept any live,
 * same-day, physical count at the site, so the screen cannot offer a count the
 * service would then refuse.
 */
export async function listTodaysVoidableCountsAtSite(
  siteId: string,
  actorUserId: string,
  now: Date = new Date(),
): Promise<VoidableCountRow[]> {
  const { start, endExclusive } = currentPacificDayWindow(now);
  const rows = await prisma.siteInventorySnapshot.findMany({
    where: {
      ...NOT_VOIDED,
      site_id: siteId,
      snapshot_kind: 'physical',
      snapshot_at: { gte: start, lt: endExclusive },
    },
    orderBy: [{ snapshot_at: 'desc' }, { created_at: 'desc' }],
    select: {
      id: true,
      // `created_at`, NOT `snapshot_at`, is what the operator is shown.
      // `snapshot_at` is Pacific MIDNIGHT of the counted day (ADR-0060 D-3), so
      // labelling rows with it renders every count of the day as "12:00 AM" —
      // which is useless for telling two of them apart, and telling two of them
      // apart is the entire task. `created_at` is the recorded insertion instant
      // (ADR-0078 D1) and is the only column that distinguishes them.
      created_at: true,
      units_indoor: true,
      units_total: true,
      units_in_processing: true,
    },
  });
  if (rows.length === 0) return [];

  // Every enterer, not just this one — the query is no longer scoped to
  // `actor_user_id` because the answer is now a LABEL rather than a filter.
  const inserts = await prisma.auditLog.findMany({
    where: { table_name: TABLE, action: 'insert', row_id: { in: rows.map((r) => r.id) } },
    orderBy: { created_at: 'asc' },
    select: { row_id: true, actor_user_id: true },
  });
  // First insert row wins, matching `voidSnapshot`'s `orderBy created_at asc`.
  const entererByRow = new Map<string, string | null>();
  for (const i of inserts) {
    if (!entererByRow.has(i.row_id)) entererByRow.set(i.row_id, i.actor_user_id);
  }

  return rows.map((r) => {
    const enteredByUserId = entererByRow.get(r.id) ?? null;
    return {
      id: r.id,
      enteredAt: r.created_at,
      physicalTotal: totalOf(r),
      enteredByUserId,
      isMine: enteredByUserId === actorUserId,
    };
  });
}
