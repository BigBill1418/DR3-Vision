// ADR-0104 §D5 — the human half of preview-then-confirm for outbound weights.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THIS FILE EXISTS BECAUSE THE LAST STAGING CLASS SHIPPED WITHOUT ONE       │
// │                                                                           │
// │ `doc_commodity_audit_rows` has held 252 `staged` rows since ADR-0080      │
// │ shipped, and there is NO confirm control anywhere in the product — no     │
// │ `commodity-decide.ts`, and `/admin/doc-ingest/commodity` is read-only.    │
// │ Those rows can never leave `staged`, so nothing can ever read them at     │
// │ `confirmed` scope. That is P-46, and it is registered rather than         │
// │ repaired. A staging class without a decide service is a promise the       │
// │ product cannot keep, so each new one ships with its own.                  │
// └───────────────────────────────────────────────────────────────────────────┘
//
// The contract is `terex-decide.ts`'s, deliberately unchanged:
//   - the batch is a VERSION, not a row — asking a human to tick 831 loads
//     individually guarantees they stop reading them;
//   - the totals are computed BEFORE the update and captured into the audit row,
//     because a CHECK constraint already enforces WHO confirmed and the harder
//     question is WHAT THEY WERE LOOKING AT when they said yes; and
//   - the actor is `{userId}` XOR `{label}` (ADR-0077). A named non-human run
//     writes `actor_label` with `actor_user_id` NULL and never borrows a
//     `users.id`.
//
// ── The one thing this adds over TEREX ─────────────────────────────────────
// Two tables. `doc_outbound_commodity_rows` mirrors its parent's status and is
// flipped IN THE SAME TRANSACTION. A child that could outlive its parent's
// decision would leave a discarded batch's per-commodity weights readable at
// `confirmed` scope — a rejected figure still in the answer.

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

/**
 * Who is accepting. Exactly one of these, and which one IS the claim being made
 * (ADR-0077).
 */
export type OutboundDecideActor = { userId: string } | { label: string };

export interface OutboundTotals {
  /** Loads in the batch. */
  loads: number;
  /** Summed `Total Outbound Weight`. NEVER the check column. */
  total_weight_lbs: number;
  /** Child rows that move with them. */
  commodity_rows: number;
}

export type OutboundDecideResult =
  | { ok: true; action: 'confirm'; rows: number; commodityRows: number; totals: OutboundTotals }
  | { ok: true; action: 'discard'; rows: number; commodityRows: number; totals: OutboundTotals }
  | { ok: false; reason: 'nothing_staged' };

export interface OutboundDecideArgs {
  versionId: string;
  actor: OutboundDecideActor;
  /** Required for `discard`; ignored on confirm. */
  reason?: string;
  now?: Date;
  db?: PrismaClient;
}

function actorFields(actor: OutboundDecideActor): {
  stamp: string;
  actor_user_id: string | null;
  actor_label: string | null;
} {
  return 'label' in actor
    ? { stamp: actor.label, actor_user_id: null, actor_label: actor.label }
    : { stamp: actor.userId, actor_user_id: actor.userId, actor_label: null };
}

/** Accept or reject a staged outbound batch — parent and child, atomically. */
export async function decideOutboundBatch(
  action: 'confirm' | 'discard',
  args: OutboundDecideArgs,
): Promise<OutboundDecideResult> {
  const db = args.db ?? defaultPrisma;
  const now = args.now ?? new Date();
  const { stamp, actor_user_id, actor_label } = actorFields(args.actor);

  const staged = await db.docOutboundLoadRow.findMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
    select: { id: true, total_weight_lbs: true },
  });
  // Not an error worth a 500 — most likely somebody else just decided it.
  if (staged.length === 0) return { ok: false, reason: 'nothing_staged' };

  const commodityRows = await db.docOutboundCommodityRow.count({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
  });

  const totals: OutboundTotals = {
    loads: staged.length,
    total_weight_lbs: staged.reduce((a, r) => a + Number(r.total_weight_lbs ?? 0), 0),
    commodity_rows: commodityRows,
  };

  const nextStatus = action === 'confirm' ? ('confirmed' as const) : ('discarded' as const);
  const parentData =
    action === 'confirm'
      ? { status: nextStatus, confirmed_at: now, confirmed_by: stamp }
      : {
          status: nextStatus,
          discarded_at: now,
          discarded_by: stamp,
          discard_reason: args.reason ?? null,
        };

  const { rows, children } = await db.$transaction(async (tx) => {
    const parent = await tx.docOutboundLoadRow.updateMany({
      where: { doc_source_version_id: args.versionId, status: 'staged' },
      data: parentData,
    });
    // Same transaction, same decision. The child carries no confirmer of its
    // own — its parent's row is the attestation, and this keeps the two from
    // ever disagreeing.
    const child = await tx.docOutboundCommodityRow.updateMany({
      where: { doc_source_version_id: args.versionId, status: 'staged' },
      data: { status: nextStatus },
    });
    return { rows: parent.count, children: child.count };
  });

  await writeAudit({
    actor_user_id,
    actor_label,
    action: 'update',
    table_name: 'doc_outbound_load_rows',
    row_id: args.versionId,
    after:
      action === 'confirm'
        ? { confirmed: true, rows, commodity_rows: children, totals_accepted: totals }
        : {
            discarded: true,
            rows,
            commodity_rows: children,
            reason: args.reason ?? null,
            totals_rejected: totals,
          },
  });

  return { ok: true, action, rows, commodityRows: children, totals };
}
