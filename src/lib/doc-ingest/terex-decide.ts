// ADR-0069 Amendment 2 — the human half of preview-then-confirm, as a service.
//
// This logic lived inline in `POST /api/admin/doc-ingest/terex`. It is lifted
// here UNCHANGED in behaviour so that the one caller that is not an HTTP request
// — the ADR-0077 one-off that accepted the first TEREX batch — drives the SAME
// code the admin button drives, rather than a hand-written `updateMany` that
// would skip the totals capture and the audit row.
//
// The route keeps `checkAdmin()`. Nothing about the HTTP gate moved.
//
// WHY THE TOTALS ARE CAPTURED INTO THE AUDIT ROW: a CHECK constraint already
// enforces that a confirmed row names who confirmed it. `totals_accepted`
// answers the harder question — WHAT they were looking at when they said yes.
// If a later read disagrees with the accepted figure, that row is the evidence
// of what was actually on screen at the moment of acceptance.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

/**
 * Who is accepting. Exactly one of these, and which one IS the claim being made
 * (ADR-0077): a real admin session, or a NAMED non-human run. `confirmed_by` is
 * a bare string column, so a label lands there and the audit row carries
 * `actor_label` with `actor_user_id` NULL — never a borrowed `users.id`.
 */
export type TerexDecideActor = { userId: string } | { label: string };

export interface TerexTotals {
  actual_repair_cost: number;
  amount_credited: number;
  estimated_cost: number;
}

export type TerexDecideResult =
  | { ok: true; action: 'confirm'; rows: number; totals: TerexTotals }
  | { ok: true; action: 'discard'; rows: number; totals: TerexTotals }
  | { ok: false; reason: 'nothing_staged' };

export interface TerexDecideArgs {
  versionId: string;
  actor: TerexDecideActor;
  /** Required for `discard`; ignored on confirm. */
  reason?: string;
  now?: Date;
  db?: PrismaClient | Prisma.TransactionClient;
}

function actorFields(actor: TerexDecideActor): {
  stamp: string;
  actor_user_id: string | null;
  actor_label: string | null;
} {
  return 'label' in actor
    ? { stamp: actor.label, actor_user_id: null, actor_label: actor.label }
    : { stamp: actor.userId, actor_user_id: actor.userId, actor_label: null };
}

/**
 * Accept or reject a staged TEREX batch.
 *
 * The batch is a VERSION, not a row: asking a human to tick eighty maintenance
 * events individually guarantees they stop reading them, so the decision is
 * taken once against the totals and the de-duplication.
 */
export async function decideTerexBatch(
  action: 'confirm' | 'discard',
  args: TerexDecideArgs,
): Promise<TerexDecideResult> {
  const db = args.db ?? defaultPrisma;
  const now = args.now ?? new Date();
  const { stamp, actor_user_id, actor_label } = actorFields(args.actor);

  const staged = await db.docTerexMaintenanceRow.findMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
    select: { id: true, actual_repair_cost: true, amount_credited: true, estimated_cost: true },
  });
  // Not an error worth a 500 — most likely somebody else just decided it.
  if (staged.length === 0) return { ok: false, reason: 'nothing_staged' };

  const sum = (pick: (r: (typeof staged)[number]) => unknown): number =>
    staged.reduce((a, r) => a + Number(pick(r) ?? 0), 0);
  const totals: TerexTotals = {
    actual_repair_cost: sum((r) => r.actual_repair_cost),
    amount_credited: sum((r) => r.amount_credited),
    estimated_cost: sum((r) => r.estimated_cost),
  };

  if (action === 'confirm') {
    const res = await db.docTerexMaintenanceRow.updateMany({
      where: { doc_source_version_id: args.versionId, status: 'staged' },
      data: { status: 'confirmed', confirmed_at: now, confirmed_by: stamp },
    });
    await writeAudit({
      actor_user_id,
      actor_label,
      action: 'update',
      table_name: 'doc_terex_maintenance_rows',
      row_id: args.versionId,
      after: { confirmed: true, rows: res.count, totals_accepted: totals },
    });
    return { ok: true, action: 'confirm', rows: res.count, totals };
  }

  const res = await db.docTerexMaintenanceRow.updateMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
    data: {
      status: 'discarded',
      discarded_at: now,
      discarded_by: stamp,
      discard_reason: args.reason ?? null,
    },
  });
  await writeAudit({
    actor_user_id,
    actor_label,
    action: 'update',
    table_name: 'doc_terex_maintenance_rows',
    row_id: args.versionId,
    after: {
      discarded: true,
      rows: res.count,
      reason: args.reason ?? null,
      totals_rejected: totals,
    },
  });
  return { ok: true, action: 'discard', rows: res.count, totals };
}
