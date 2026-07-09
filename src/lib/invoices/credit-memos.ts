// 2026-07-09 rollup §1.4 (ADR-0041 addendum) — the invoice-correction state
// machine Mary described.
//
// Two correction paths exist in GP reality:
//   - UNDER-billed → void-and-reissue: already the ADR-0041 supersede chain
//     (`supersedeInvoice`) — nothing new here.
//   - OVER-billed → a credit memo, IF MRC agrees; if MRC declines, fall back to
//     void-and-reissue. MRC's acceptance is REQUIRED for the credit path, so a
//     credit memo can never be applied unilaterally (unlike ADR-0028/0029 bonus
//     amendments, which are admin-side) — hence an explicit state machine:
//
//       proposed → sent_to_mrc → accepted → applied
//                              → rejected → void_and_reissue_triggered
//
// Every transition is enforced against ALLOWED_TRANSITIONS (a typed 409 on an
// illegal jump), audited, and stamped. `void_and_reissue_triggered` composes
// with the existing supersede chain: it generates the superseding DRAFT via
// `supersedeInvoice` and records its id on the memo — the draft then goes
// through the normal ADR-0041 approval (gate included).

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { supersedeInvoice } from './lifecycle';
import { InvoiceNotFoundError } from './view';

const TABLE = 'credit_memos';

export type CreditMemoStatus =
  | 'proposed'
  | 'sent_to_mrc'
  | 'accepted'
  | 'rejected'
  | 'applied'
  | 'void_and_reissue_triggered';

/** The legal state machine (rollup §1.4). Terminal states map to []. */
export const ALLOWED_TRANSITIONS: Record<CreditMemoStatus, readonly CreditMemoStatus[]> = {
  proposed: ['sent_to_mrc'],
  sent_to_mrc: ['accepted', 'rejected'],
  accepted: ['applied'],
  rejected: ['void_and_reissue_triggered'],
  applied: [],
  void_and_reissue_triggered: [],
};

/** An illegal credit-memo status transition was attempted. */
export class CreditMemoTransitionError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly from: CreditMemoStatus,
    readonly to: CreditMemoStatus,
  ) {
    super(
      `credit memo transition ${from} → ${to} is not legal; allowed from ${from}: ` +
        `[${ALLOWED_TRANSITIONS[from].join(', ') || 'none — terminal'}]`,
    );
    this.name = 'CreditMemoTransitionError';
  }
}

/** Credit memos are raised only against APPROVED invoices / with a real amount. */
export class CreditMemoValidationError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly reason: 'invoice_not_approved' | 'amount_not_positive' | 'reason_required',
    message: string,
  ) {
    super(message);
    this.name = 'CreditMemoValidationError';
  }
}

export class CreditMemoNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(readonly id: string) {
    super(`credit memo ${id} not found`);
    this.name = 'CreditMemoNotFoundError';
  }
}

export interface CreditMemoView {
  id: string;
  invoiceId: string;
  siteId: string;
  amountCents: number;
  reason: string;
  status: CreditMemoStatus;
  supersedingInvoiceId: string | null;
  createdBy: string | null;
  sentAt: Date | null;
  decidedAt: Date | null;
  decidedNote: string | null;
  appliedAt: Date | null;
  createdAt: Date;
}

interface MemoRow {
  id: string;
  invoice_id: string;
  site_id: string;
  amount_cents: number;
  reason: string;
  status: string;
  superseding_invoice_id: string | null;
  created_by: string | null;
  sent_at: Date | null;
  decided_at: Date | null;
  decided_note: string | null;
  applied_at: Date | null;
  created_at: Date;
}

function toView(row: MemoRow): CreditMemoView {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    siteId: row.site_id,
    amountCents: row.amount_cents,
    reason: row.reason,
    status: row.status as CreditMemoStatus,
    supersedingInvoiceId: row.superseding_invoice_id,
    createdBy: row.created_by,
    sentAt: row.sent_at,
    decidedAt: row.decided_at,
    decidedNote: row.decided_note,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
  };
}

export interface CreateCreditMemoArgs {
  siteId: string;
  invoiceId: string;
  /** POSITIVE cents — the credit owed back to MRC. */
  amountCents: number;
  /** Plain-English over-billing reason; required (it rides the audit row). */
  reason: string;
  actorUserId: string;
}

/**
 * Raise a credit memo (status `proposed`) against an APPROVED invoice. The
 * invoice itself is untouched — approved rows stay immutable; the memo is the
 * correction artifact.
 */
export async function createCreditMemo(args: CreateCreditMemoArgs): Promise<CreditMemoView> {
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    throw new CreditMemoValidationError(
      'amount_not_positive',
      'credit memo amount must be positive integer cents',
    );
  }
  if (!args.reason.trim()) {
    throw new CreditMemoValidationError(
      'reason_required',
      'a credit memo requires a plain-English reason',
    );
  }
  const invoice = await prisma.invoice.findFirst({
    where: { id: args.invoiceId, site_id: args.siteId },
    select: { id: true, status: true },
  });
  if (!invoice) throw new InvoiceNotFoundError(args.invoiceId);
  if (invoice.status !== 'approved') {
    throw new CreditMemoValidationError(
      'invoice_not_approved',
      `invoice ${invoice.id} is ${invoice.status}; a credit memo corrects only an APPROVED invoice ` +
        `(a draft is simply regenerated)`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const memo = await tx.creditMemo.create({
      data: {
        invoice_id: args.invoiceId,
        site_id: args.siteId,
        amount_cents: args.amountCents,
        reason: args.reason.trim(),
        created_by: args.actorUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'insert',
        table_name: TABLE,
        row_id: memo.id,
        after: { invoice_id: args.invoiceId, amount_cents: args.amountCents, status: 'proposed' },
      },
    });
    return memo;
  });

  log.info(
    {
      op: 'credit_memo.create',
      site_id: args.siteId,
      invoice_id: args.invoiceId,
      memo_id: created.id,
      amount_cents: args.amountCents,
    },
    '[credit-memos] proposed',
  );
  return toView(created);
}

export interface TransitionCreditMemoArgs {
  siteId: string;
  memoId: string;
  to: CreditMemoStatus;
  actorUserId: string;
  /** MRC's accept/reject context, or the applied confirmation note. */
  note?: string;
}

/**
 * Walk a credit memo one legal step. Side effects by target state:
 *   sent_to_mrc → stamps sent_at.
 *   accepted / rejected → stamps decided_at (+ optional note).
 *   applied → stamps applied_at (Mary confirms MRC applied the credit in GP).
 *   void_and_reissue_triggered → generates the superseding DRAFT via the
 *     ADR-0041 supersede chain and records its id on the memo.
 */
export async function transitionCreditMemo(
  args: TransitionCreditMemoArgs,
): Promise<CreditMemoView> {
  const row = await prisma.creditMemo.findFirst({
    where: { id: args.memoId, site_id: args.siteId },
  });
  if (!row) throw new CreditMemoNotFoundError(args.memoId);
  const from = row.status as CreditMemoStatus;
  if (!ALLOWED_TRANSITIONS[from].includes(args.to)) {
    throw new CreditMemoTransitionError(from, args.to);
  }

  // The reissue path composes with the supersede chain OUTSIDE the memo update
  // transaction: generateInvoiceDraft owns its own transaction + audit row, and
  // a failed draft generation must abort the transition (memo stays `rejected`).
  let supersedingInvoiceId: string | null = null;
  if (args.to === 'void_and_reissue_triggered') {
    const draft = await supersedeInvoice({
      siteId: args.siteId,
      invoiceId: row.invoice_id,
      actorUserId: args.actorUserId,
      notes: `credit memo ${row.id} rejected by MRC — void-and-reissue (rollup §1.4)`,
    });
    supersedingInvoiceId = draft.id;
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.creditMemo.update({
      where: { id: row.id },
      data: {
        status: args.to,
        ...(args.to === 'sent_to_mrc' ? { sent_at: now } : {}),
        ...(args.to === 'accepted' || args.to === 'rejected'
          ? { decided_at: now, decided_note: args.note?.trim() || null }
          : {}),
        ...(args.to === 'applied' ? { applied_at: now } : {}),
        ...(supersedingInvoiceId ? { superseding_invoice_id: supersedingInvoiceId } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: row.id,
        before: { status: from },
        after: {
          status: args.to,
          ...(args.note ? { note: args.note } : {}),
          ...(supersedingInvoiceId ? { superseding_invoice_id: supersedingInvoiceId } : {}),
        },
      },
    });
    return u;
  });

  log.info(
    {
      op: 'credit_memo.transition',
      site_id: args.siteId,
      memo_id: row.id,
      from,
      to: args.to,
      superseding_invoice_id: supersedingInvoiceId,
    },
    '[credit-memos] transitioned',
  );
  return toView(updated);
}

/** Site-scoped list, newest first (admin surface read). */
export async function listCreditMemos(siteId: string, limit = 100): Promise<CreditMemoView[]> {
  const rows = await prisma.creditMemo.findMany({
    where: { site_id: siteId },
    orderBy: { created_at: 'desc' },
    take: limit,
  });
  return rows.map(toView);
}
