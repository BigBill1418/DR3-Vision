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

import type { CreditMemo as PrismaCreditMemo } from '@prisma/client';
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
    readonly reason:
      | 'invoice_not_approved'
      | 'amount_not_positive'
      | 'amount_exceeds_invoice'
      | 'cumulative_exceeds_invoice'
      | 'open_memo_exists'
      | 'reason_required',
    message: string,
  ) {
    super(message);
    this.name = 'CreditMemoValidationError';
  }
}

/**
 * Credit memos consuming this invoice's budget for the cumulative cap (M3): every
 * memo that is either applied OR still in flight toward being applied. A memo that
 * went `void_and_reissue_triggered` chose the supersede path instead of a credit,
 * so it consumes no credit budget and is excluded.
 */
const CAP_CONSUMING_STATUSES: readonly CreditMemoStatus[] = [
  'proposed',
  'sent_to_mrc',
  'accepted',
  'rejected',
  'applied',
];

/**
 * The money invariant behind M3: a NEW credit memo may not push the running
 * total of applied + in-flight credits past the invoice total. The per-memo
 * bound (`≤ total_cents`) alone let a fresh memo up to the full total be raised
 * AFTER an earlier one applied, so `Σ applied` could exceed what was invoiced.
 * Pure so the arithmetic is unit-tested directly (the aggregate wiring is
 * exercised at the route level). Throws when `prior + amount > total`.
 */
export function assertWithinCumulativeCap(args: {
  invoiceId: string;
  priorConsumedCents: number;
  amountCents: number;
  invoiceTotalCents: number;
}): void {
  if (args.priorConsumedCents + args.amountCents > args.invoiceTotalCents) {
    throw new CreditMemoValidationError(
      'cumulative_exceeds_invoice',
      `credit memo amount (${args.amountCents}¢) plus existing applied/in-flight credits ` +
        `(${args.priorConsumedCents}¢) would exceed the invoice total ` +
        `(${args.invoiceTotalCents}¢) for invoice ${args.invoiceId}`,
    );
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

function toView(row: PrismaCreditMemo): CreditMemoView {
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
    select: { id: true, status: true, total_cents: true },
  });
  if (!invoice) throw new InvoiceNotFoundError(args.invoiceId);
  if (invoice.status !== 'approved') {
    throw new CreditMemoValidationError(
      'invoice_not_approved',
      `invoice ${invoice.id} is ${invoice.status}; a credit memo corrects only an APPROVED invoice ` +
        `(a draft is simply regenerated)`,
    );
  }
  // An over-credit leaves the building (the memo is what MRC receives) — bound
  // it to the invoiced amount, and refuse a second concurrent correction: one
  // open memo per invoice at a time (terminal memos don't block a new one).
  if (args.amountCents > invoice.total_cents) {
    throw new CreditMemoValidationError(
      'amount_exceeds_invoice',
      `credit memo amount (${args.amountCents}¢) exceeds the invoice total (${invoice.total_cents}¢)`,
    );
  }
  // Cumulative cap (M3): the per-memo bound above is not enough — once a memo
  // goes terminal, a fresh memo up to the full total could be raised, so Σ of
  // applied + in-flight credits could exceed the invoice. Sum the budget-
  // consuming memos and refuse a new one that would push the running total over.
  const consumed = await prisma.creditMemo.aggregate({
    where: { invoice_id: args.invoiceId, status: { in: [...CAP_CONSUMING_STATUSES] } },
    _sum: { amount_cents: true },
  });
  assertWithinCumulativeCap({
    invoiceId: args.invoiceId,
    priorConsumedCents: consumed._sum.amount_cents ?? 0,
    amountCents: args.amountCents,
    invoiceTotalCents: invoice.total_cents,
  });
  const openMemo = await prisma.creditMemo.findFirst({
    where: {
      invoice_id: args.invoiceId,
      status: { in: ['proposed', 'sent_to_mrc', 'accepted', 'rejected'] },
    },
    select: { id: true, status: true },
  });
  if (openMemo) {
    throw new CreditMemoValidationError(
      'open_memo_exists',
      `invoice ${invoice.id} already has an open credit memo (${openMemo.id}, ${openMemo.status}) — ` +
        `walk it to a terminal state first`,
    );
  }

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
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
  } catch (e) {
    // The partial unique index credit_memos_one_open_per_invoice_key is the
    // atomic form of the open-memo pre-check above (findFirst-then-create
    // races under concurrency; the index does not).
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
      throw new CreditMemoValidationError(
        'open_memo_exists',
        `invoice ${args.invoiceId} already has an open credit memo (concurrent create lost the race)`,
      );
    }
    throw e;
  }

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
 * Walk a credit memo one legal step. The transition is an atomic
 * compare-and-swap — `updateMany({ where: { id, status: from } })` — so a
 * concurrent/duplicate request loses the race and gets the typed 409 instead
 * of silently double-transitioning (the earlier check-then-act shape let two
 * callers both pass the guard). Side effects by target state:
 *   sent_to_mrc → stamps sent_at.
 *   accepted / rejected → stamps decided_at (+ optional note).
 *   applied → stamps applied_at (Mary confirms MRC applied the credit in GP).
 *   void_and_reissue_triggered → CAS-claims the memo FIRST (so exactly one
 *     caller generates the draft), then runs the ADR-0041 supersede chain and
 *     records the draft id. If the supersede fails (e.g. the invoice was voided
 *     out-of-band after rejection), the claim is compensated back to `rejected`
 *     and the invoice-level error propagates — the memo is never left terminal
 *     without its draft. (A crash between claim and compensation can strand the
 *     memo in `void_and_reissue_triggered` with a null draft id; the audit rows
 *     make that visible, and a memo-cancel state is an open §D review item.)
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

  const now = new Date();

  // Atomic claim: only the caller whose CAS matches `from` proceeds.
  const claim = async (data: Record<string, unknown>): Promise<void> => {
    const res = await prisma.$transaction(async (tx) => {
      const updated = await tx.creditMemo.updateMany({
        where: { id: row.id, site_id: args.siteId, status: from },
        data: { status: args.to, ...data },
      });
      if (updated.count === 0) return false;
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: TABLE,
          row_id: row.id,
          before: { status: from },
          after: { status: args.to, ...(args.note ? { note: args.note } : {}) },
        },
      });
      return true;
    });
    if (!res) {
      const current = await prisma.creditMemo.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      throw new CreditMemoTransitionError((current?.status ?? from) as CreditMemoStatus, args.to);
    }
  };

  if (args.to !== 'void_and_reissue_triggered') {
    await claim({
      ...(args.to === 'sent_to_mrc' ? { sent_at: now } : {}),
      ...(args.to === 'accepted' || args.to === 'rejected'
        ? { decided_at: now, decided_note: args.note?.trim() || null }
        : {}),
      ...(args.to === 'applied' ? { applied_at: now } : {}),
    });
  } else {
    // Claim first (exactly one caller wins), then the side effect.
    await claim({});
    let supersedingInvoiceId: string;
    try {
      const draft = await supersedeInvoice({
        siteId: args.siteId,
        invoiceId: row.invoice_id,
        actorUserId: args.actorUserId,
        notes: `credit memo ${row.id} rejected by MRC — void-and-reissue (rollup §1.4)`,
      });
      supersedingInvoiceId = draft.id;
    } catch (e) {
      // Compensate: give the memo its `rejected` state back so the operator can
      // retry (or resolve the invoice problem — e.g. it was voided out-of-band).
      await prisma.$transaction(async (tx) => {
        await tx.creditMemo.updateMany({
          where: { id: row.id, status: 'void_and_reissue_triggered' },
          data: { status: 'rejected' },
        });
        await tx.auditLog.create({
          data: {
            actor_user_id: args.actorUserId,
            action: 'update',
            table_name: TABLE,
            row_id: row.id,
            before: { status: 'void_and_reissue_triggered' },
            after: { status: 'rejected', note: 'reissue draft generation failed — compensated' },
          },
        });
      });
      throw e;
    }
    // L2: the tail write recording the generated draft's id was previously a bare,
    // UNAUDITED update — the one credit-memo mutation with no audit trail. Fold it
    // and its audit row into one transaction so the link and its record commit
    // together (append-only trail intact, CLAUDE.md hard rule #6).
    await prisma.$transaction(async (tx) => {
      await tx.creditMemo.update({
        where: { id: row.id },
        data: { superseding_invoice_id: supersedingInvoiceId },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: TABLE,
          row_id: row.id,
          before: { superseding_invoice_id: null },
          after: { superseding_invoice_id: supersedingInvoiceId },
        },
      });
    });
  }

  const updated = await prisma.creditMemo.findUniqueOrThrow({ where: { id: row.id } });
  log.info(
    {
      op: 'credit_memo.transition',
      site_id: args.siteId,
      memo_id: row.id,
      from,
      to: args.to,
      superseding_invoice_id: updated.superseding_invoice_id,
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
