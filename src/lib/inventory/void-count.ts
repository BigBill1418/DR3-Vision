// ADR-0084 — same-day operator VOID of a physical inventory count.
//
// JT: "if we accidentally entered the count twice, we should be able to remove
// one." Bill: same-day only on the iPad; prior day is an office job.
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

/** The caller did not enter this count, so they may not withdraw it. */
export class SnapshotNotYoursError extends Error {
  readonly status = 403;
  readonly reason = 'not_your_count';
  constructor() {
    super('not_your_count');
    this.name = 'SnapshotNotYoursError';
  }
}

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
}

function totalOf(row: {
  units_indoor: number | null;
  units_total: number | null;
  units_in_processing: number;
}): number {
  return (row.units_total ?? row.units_indoor ?? 0) + row.units_in_processing;
}

/**
 * Withdraw a physical count taken TODAY (Pacific) by the calling operator.
 *
 * Gates, in order, all before anything is written:
 *
 *   1. Exists, and belongs to `siteId` (hard rule #2 — a snapshot id from
 *      another site is a 404, not a 403: the caller learns nothing).
 *   2. Is a `physical` count. `computed` markers are system-derived.
 *   3. Was counted on the CURRENT PACIFIC day — never the device clock, never
 *      server-local. The container runs UTC, so a server-local "today" flips at
 *      5 PM Pacific and would start refusing an evening-shift operator's real
 *      day while accepting tomorrow's.
 *   4. Was entered by this operator, resolved from the append-only `audit_logs`
 *      insert row (the same provenance path `eod-inventory.resolveCounter` uses
 *      — the audit log IS the record of who, so there is one truth rather than a
 *      denormalised copy that can disagree with it).
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

  // ── Yours ────────────────────────────────────────────────────────────────
  // An operator may withdraw a count THEY entered. Resolved from the audit row
  // `reconcilePhysicalCount` wrote in the same transaction as the insert;
  // snapshots carry no counter column, and adding one would create a second
  // truth that could disagree with the append-only record.
  //
  // `findFirst` + `orderBy created_at asc`: the ORIGINAL insert row, matching
  // `resolveCounter`. A later audit row on the same snapshot (this void, an
  // anchor reactivation note) must never be mistaken for the entry.
  const entry = await prisma.auditLog.findFirst({
    where: { table_name: TABLE, row_id: snapshot.id, action: 'insert' },
    orderBy: { created_at: 'asc' },
    select: { actor_user_id: true },
  });
  if (entry?.actor_user_id !== args.actorUserId) throw new SnapshotNotYoursError();

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
        async () => voidWrite(tx, snapshot.id, args, now, physicalTotal),
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
        physical_total: physicalTotal,
        reason: 'operator_same_day_void',
      },
    },
  });

  return { snapshotId, voidedAt: now.toISOString(), alreadyVoided: false, physicalTotal };
}

/**
 * Today's (Pacific) physical counts for a site that THIS operator entered — the
 * set the iPad may offer to void.
 *
 * Voided rows are excluded (`NOT_VOIDED`): the screen offers an ACTION, and a
 * withdrawn count is not actionable. The recovery surfaces are where a voided
 * count stays visible.
 *
 * Ownership is filtered through the same append-only audit row `voidSnapshot`
 * checks, so the list cannot offer a count the service would then refuse.
 */
export async function listTodaysVoidableCounts(
  siteId: string,
  actorUserId: string,
  now: Date = new Date(),
): Promise<Array<{ id: string; enteredAt: Date; physicalTotal: number }>> {
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

  const mine = await prisma.auditLog.findMany({
    where: {
      table_name: TABLE,
      action: 'insert',
      actor_user_id: actorUserId,
      row_id: { in: rows.map((r) => r.id) },
    },
    select: { row_id: true },
  });
  const mineIds = new Set(mine.map((m) => m.row_id));

  return rows
    .filter((r) => mineIds.has(r.id))
    .map((r) => ({ id: r.id, enteredAt: r.created_at, physicalTotal: totalOf(r) }));
}
