// ADR-0104 §D5 — the human half of preview-then-confirm for facility expenses.
//
// Same contract as `terex-decide.ts` and `outbound-decide.ts`: the batch is a
// VERSION, the totals are captured into the audit row as the evidence of what
// was on screen at the moment of acceptance, and the actor is `{userId}` XOR
// `{label}` (ADR-0077) — a named non-human run writes `actor_label` with
// `actor_user_id` NULL and never borrows a `users.id`.
//
// This one is a single table, so it is the plainer of the two. It exists for the
// same reason: a staging class without a decide service is 252 rows that can
// never leave `staged` (P-46).

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

export type FacilityExpenseDecideActor = { userId: string } | { label: string };

export interface FacilityExpenseTotals {
  rows: number;
  amount: number;
  credit_amount: number;
  /** Rows whose amount cell was BLANK. Never counted as $0 — see the extractor. */
  rows_without_an_amount: number;
}

export type FacilityExpenseDecideResult =
  | { ok: true; action: 'confirm'; rows: number; totals: FacilityExpenseTotals }
  | { ok: true; action: 'discard'; rows: number; totals: FacilityExpenseTotals }
  | { ok: false; reason: 'nothing_staged' };

export interface FacilityExpenseDecideArgs {
  versionId: string;
  actor: FacilityExpenseDecideActor;
  /** Required for `discard`; ignored on confirm. */
  reason?: string;
  now?: Date;
  db?: PrismaClient | Prisma.TransactionClient;
}

function actorFields(actor: FacilityExpenseDecideActor): {
  stamp: string;
  actor_user_id: string | null;
  actor_label: string | null;
} {
  return 'label' in actor
    ? { stamp: actor.label, actor_user_id: null, actor_label: actor.label }
    : { stamp: actor.userId, actor_user_id: actor.userId, actor_label: null };
}

/** Accept or reject a staged facility-expense batch. */
export async function decideFacilityExpenseBatch(
  action: 'confirm' | 'discard',
  args: FacilityExpenseDecideArgs,
): Promise<FacilityExpenseDecideResult> {
  const db = args.db ?? defaultPrisma;
  const now = args.now ?? new Date();
  const { stamp, actor_user_id, actor_label } = actorFields(args.actor);

  const staged = await db.docFacilityExpenseRow.findMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
    select: { id: true, amount: true, credit_amount: true },
  });
  if (staged.length === 0) return { ok: false, reason: 'nothing_staged' };

  const totals: FacilityExpenseTotals = {
    rows: staged.length,
    amount: staged.reduce((a, r) => a + Number(r.amount ?? 0), 0),
    credit_amount: staged.reduce((a, r) => a + Number(r.credit_amount ?? 0), 0),
    // Recorded because the two figures above CANNOT show it: a blank amount and
    // a $0.00 amount contribute the same nothing to a sum, and only one of them
    // means the operator recorded a price.
    rows_without_an_amount: staged.filter((r) => r.amount === null).length,
  };

  if (action === 'confirm') {
    const res = await db.docFacilityExpenseRow.updateMany({
      where: { doc_source_version_id: args.versionId, status: 'staged' },
      data: { status: 'confirmed', confirmed_at: now, confirmed_by: stamp },
    });
    await writeAudit({
      actor_user_id,
      actor_label,
      action: 'update',
      table_name: 'doc_facility_expense_rows',
      row_id: args.versionId,
      after: { confirmed: true, rows: res.count, totals_accepted: totals },
    });
    return { ok: true, action: 'confirm', rows: res.count, totals };
  }

  const res = await db.docFacilityExpenseRow.updateMany({
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
    table_name: 'doc_facility_expense_rows',
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
