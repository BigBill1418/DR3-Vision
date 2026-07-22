// ADR-0057 D4 — reconciliation decision engine (the operational write gate).
//
// Vision NEVER auto-updates operational tables from MyMRC. Mirror sync writes
// candidate changes to `mymrc_reconciliation_queue`; an admin approves/rejects/
// snoozes each one here. ONLY an explicit approve writes an operational table — a
// reject writes nothing, a snooze defers 7 days. Every decision is first-action-
// wins (atomic conditional transition) and audited in the SAME transaction as the
// state flip, so a crash between the flip and its audit is impossible (mirrors the
// AP decide path, ADR-0046 approvals.ts).
//
// This lives under `src/lib/reconcile` (NOT `src/lib/mymrc`) precisely so it may
// import `@/lib/prisma` + `@/lib/audit` — the mymrc lib is dual-compiled and can't.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { Prisma, PrismaClient, ReconChangeKind, ReconStatus } from '@prisma/client';
import { writeAudit } from '@/lib/audit';

const TABLE = 'mymrc_reconciliation_queue';
const ACTOR_LABEL = 'admin:mymrc-reconcile';
export const SNOOZE_DAYS = 7;

/** Statuses from which an item can still be decided (an untouched or snoozed row). */
const ACTIONABLE: readonly ReconStatus[] = ['pending', 'snoozed'];

export type ReconDecision = 'approved' | 'rejected' | 'snoozed';

export class ReconNoteRequiredError extends Error {
  readonly status = 400 as const;
  constructor(decision: ReconDecision) {
    super(
      decision === 'approved'
        ? 'An approval must include a note describing the change being applied and why.'
        : decision === 'rejected'
          ? 'A rejection must include a note explaining why the change was rejected.'
          : 'A snooze must include a note explaining why the decision is being deferred.',
    );
    this.name = 'ReconNoteRequiredError';
  }
}

export class ReconNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(id: string) {
    super(`reconciliation item ${id} not found`);
    this.name = 'ReconNotFoundError';
  }
}

export class ReconNotActionableError extends Error {
  readonly status = 409 as const;
  constructor(readonly currentStatus: string) {
    super(`item is ${currentStatus}; only a pending or snoozed item can be decided`);
    this.name = 'ReconNotActionableError';
  }
}

/** An approve targeting a change_kind/target the engine does not (yet) apply. */
export class ReconUnsupportedTargetError extends Error {
  readonly status = 400 as const;
  constructor(mirrorTable: string, targetTable: string, changeKind: string) {
    super(
      `no apply rule for ${changeKind} on ${targetTable} (from ${mirrorTable}); reject or handle manually`,
    );
    this.name = 'ReconUnsupportedTargetError';
  }
}

function hasNote(note: string | undefined | null): note is string {
  return typeof note === 'string' && note.trim().length > 0;
}

/**
 * Every reconciliation decision (approve/reject/snooze) must carry a non-empty
 * note (mirrors the AP `assertDecisionNote` idiom). Kept separate from the apply
 * fn so callers validate BEFORE any state change. Throws {@link ReconNoteRequiredError}.
 */
export function assertReconcileNote(
  decision: ReconDecision,
  note: string | undefined | null,
): void {
  if (hasNote(note)) return;
  throw new ReconNoteRequiredError(decision);
}

export interface PendingFilter {
  mirrorTable?: string;
  changeKind?: ReconChangeKind;
}

/**
 * List actionable reconciliation items (status `pending`, plus `snoozed` whose
 * 7-day wake time has passed), newest first, optionally filtered by mirror_table +
 * change_kind (the D4 pending-queue view; hits the `[status, mirror_table,
 * change_kind]` index).
 */
export async function listPendingReconciliations(
  args: PendingFilter & { prisma?: PrismaClient; now?: Date } = {},
) {
  const prisma = args.prisma ?? defaultPrisma;
  const now = args.now ?? new Date();
  return prisma.mymrcReconciliationQueue.findMany({
    where: {
      OR: [{ status: 'pending' }, { status: 'snoozed', snooze_until: { lte: now } }],
      ...(args.mirrorTable ? { mirror_table: args.mirrorTable } : {}),
      ...(args.changeKind ? { change_kind: args.changeKind } : {}),
    },
    orderBy: { created_at: 'desc' },
  });
}

/**
 * Count of actionable reconciliation items (pending + woken snoozed) — drives the
 * dashboard tile badge. Mirrors `pendingApCount`.
 */
export async function pendingReconcileCount(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<number> {
  return prisma.mymrcReconciliationQueue.count({
    where: { OR: [{ status: 'pending' }, { status: 'snoozed', snooze_until: { lte: now } }] },
  });
}

interface QueueRowForApply {
  id: string;
  mirror_table: string;
  mirror_record_id: string;
  target_table: string;
  change_kind: ReconChangeKind;
  field_name: string;
  mymrc_value: Prisma.JsonValue;
}

interface TargetWrite {
  table: string;
  rowId: string;
  after: Prisma.InputJsonValue;
}

/**
 * Resolve the `site_id` a mirror record belongs to (needed to create a scoped
 * `sources` row on approve). Only the processed mirror is wired in this wave — the
 * classifier emits only `mymrc_processed_mirror`. Other mirrors throw so an approve
 * never writes an unscoped/wrong-site row.
 */
async function mirrorSiteId(tx: Prisma.TransactionClient, row: QueueRowForApply): Promise<string> {
  if (row.mirror_table === 'mymrc_processed_mirror') {
    const rec = await tx.mymrcProcessedMirror.findUnique({
      where: { id: row.mirror_record_id },
      select: { site_id: true },
    });
    if (!rec) throw new ReconNotFoundError(`mirror row ${row.mirror_record_id}`);
    // site_id is nullable (ADR-0057 Phase 1: derived on the detail pass). A mirror
    // row whose site is not yet resolved must never approve into an unscoped
    // `sources` row — surface it as not-found rather than write a wrong-site row.
    if (!rec.site_id) {
      throw new ReconNotFoundError(`unresolved site_id for mirror row ${row.mirror_record_id}`);
    }
    return rec.site_id;
  }
  throw new ReconUnsupportedTargetError(row.mirror_table, row.target_table, row.change_kind);
}

/**
 * Apply an approved change to its operational target INSIDE the caller's tx. Only
 * `new_record → sources` (the sole change_kind this wave's classifier produces) is
 * implemented; anything else throws {@link ReconUnsupportedTargetError} rather than
 * silently no-op'ing — an unrecognized approve must never leave the queue thinking
 * it wrote when it didn't. Returns the audit descriptor for the operational write.
 */
async function applyToTarget(
  tx: Prisma.TransactionClient,
  row: QueueRowForApply,
): Promise<TargetWrite> {
  if (row.target_table === 'sources' && row.change_kind === 'new_record') {
    const name = typeof row.mymrc_value === 'string' ? row.mymrc_value.trim() : '';
    if (!name) {
      throw new ReconUnsupportedTargetError(row.mirror_table, row.target_table, row.change_kind);
    }
    const siteId = await mirrorSiteId(tx, row);
    const created = await tx.source.create({ data: { site_id: siteId, name } });
    return { table: 'sources', rowId: created.id, after: { site_id: siteId, name } };
  }
  throw new ReconUnsupportedTargetError(row.mirror_table, row.target_table, row.change_kind);
}

export interface DecideReconcileArgs {
  prisma?: PrismaClient;
  id: string;
  decision: ReconDecision;
  actorUserId: string;
  /** REQUIRED (validate with assertReconcileNote at the boundary before calling). */
  note: string;
  now?: Date;
}

export interface DecideReconcileResult {
  id: string;
  decision: ReconDecision;
  /** The operational write an approve produced (null for reject/snooze). */
  applied: TargetWrite | null;
}

/**
 * Decide one reconciliation item (approve/reject/snooze), first-action-wins. The
 * operational write (approve only), the status flip, and the audit row all commit
 * in ONE transaction — a reject/snooze writes no operational table. A row already
 * decided (or racing) matches nothing on the conditional update → 0 rows →
 * {@link ReconNotActionableError}.
 */
export async function applyReconcileDecision(
  args: DecideReconcileArgs,
): Promise<DecideReconcileResult> {
  const prisma = args.prisma ?? defaultPrisma;
  const now = args.now ?? new Date();

  const row = await prisma.mymrcReconciliationQueue.findUnique({
    where: { id: args.id },
    select: {
      id: true,
      status: true,
      mirror_table: true,
      mirror_record_id: true,
      target_table: true,
      change_kind: true,
      field_name: true,
      mymrc_value: true,
    },
  });
  if (!row) throw new ReconNotFoundError(args.id);
  if (!ACTIONABLE.includes(row.status)) throw new ReconNotActionableError(row.status);

  return prisma.$transaction(async (tx) => {
    let applied: TargetWrite | null = null;
    if (args.decision === 'approved') {
      // Write the operational table FIRST (inside the tx). If it throws (unsupported
      // target, unique clash, missing mirror) the whole tx rolls back — the item
      // stays actionable, nothing half-applied.
      applied = await applyToTarget(tx, row);
    }

    const data: Prisma.MymrcReconciliationQueueUpdateManyMutationInput = {
      status: args.decision,
      decision_note: args.note.trim(),
      // Snooze is a DEFERRAL, not a terminal decision: keep decided_at/by null so it
      // can be decided later; set the 7-day wake time. Approve/reject are terminal.
      ...(args.decision === 'snoozed'
        ? { snooze_until: new Date(now.getTime() + SNOOZE_DAYS * 24 * 60 * 60 * 1000) }
        : { decided_at: now, decided_by: args.actorUserId }),
    };
    // Conditional transition — only a still-actionable row flips (first action wins).
    const res = await tx.mymrcReconciliationQueue.updateMany({
      where: { id: args.id, status: { in: [...ACTIONABLE] } },
      data,
    });
    if (res.count === 0) {
      // Lost the race — the operational write (if any) rolls back with this throw.
      throw new ReconNotActionableError('already decided');
    }

    await writeAudit(
      {
        actor_user_id: args.actorUserId,
        actor_label: ACTOR_LABEL,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before: { status: row.status },
        after: {
          decision: args.decision,
          applied_table: applied?.table ?? null,
          applied_row_id: applied?.rowId ?? null,
          has_note: true,
        },
      },
      { tx },
    );
    return { id: args.id, decision: args.decision, applied };
  });
}

export interface BulkApproveArgs {
  prisma?: PrismaClient;
  mirrorTable: string;
  changeKind: ReconChangeKind;
  actorUserId: string;
  note: string;
  now?: Date;
}

export interface BulkApproveResult {
  approved: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Bulk-approve every actionable item of one class (mirror_table + change_kind),
 * e.g. "approve all new_record from mymrc_processed_mirror". Each item is decided
 * in its OWN transaction so one bad apply (unique clash, unsupported target) fails
 * that item ALONE and never rolls back the others. The required note is applied to
 * all. Returns the ids approved + per-id failures.
 */
export async function bulkApproveReconciliations(
  args: BulkApproveArgs,
): Promise<BulkApproveResult> {
  const prisma = args.prisma ?? defaultPrisma;
  const pending = await listPendingReconciliations({
    prisma,
    mirrorTable: args.mirrorTable,
    changeKind: args.changeKind,
    ...(args.now ? { now: args.now } : {}),
  });
  const approved: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const item of pending) {
    try {
      await applyReconcileDecision({
        prisma,
        id: item.id,
        decision: 'approved',
        actorUserId: args.actorUserId,
        note: args.note,
        ...(args.now ? { now: args.now } : {}),
      });
      approved.push(item.id);
    } catch (e) {
      failed.push({ id: item.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { approved, failed };
}
