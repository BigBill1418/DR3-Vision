// ADR-0041 D1/D4 — invoice lifecycle transitions (approve, void, supersede) +
// the approver rule.
//
// Immutability is enforced at the SERVICE layer: an approved invoice never
// mutates — a correction is a NEW version in a `supersedes_id` chain, both rows
// retained (the audit trail IS the point). `approveInvoice` is the gate
// enforcement + freeze point ("generating the non-draft invoice", D4): it
// re-asserts the total==Σlines invariant (ADR-0033 tripwire), runs the ADR-0039
// trust gate (refuse with the finding list, or a super-admin override with an
// audited justification), checks authorization, then freezes.
//
// APPROVER RULE (D4): manager-of-site OR admin. `can_manage_rates` is NEVER
// sufficient and is NEVER consulted here (it grants exactly the four rate tables'
// writes, nothing else — hard rule #2). `canApprove` doesn't even take the flag,
// so it cannot leak approval authority by construction.

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { recordGateOverride } from '@/lib/audit/billing-gate';
import { generateInvoiceDraft, loadInvoiceRow } from './service';
import { evaluateWindowGate, InvoiceGateBlockedError } from './gate';
import {
  assertTotalMatchesLines,
  InvoiceImmutableError,
  InvoiceNotFoundError,
  toInvoiceView,
  type InvoiceView,
} from './view';
import type { ManualLine } from './types';

const TABLE = 'invoices';

/** Caller identity for an approval/supersede decision (route-resolved). */
export interface ApproverContext {
  userId: string;
  role: 'operator' | 'manager' | 'admin';
  /** True iff this manager manages the invoice's site (primary_site_id match). */
  managesSite: boolean;
  /** Super-admin may override a blocked trust gate with a justification (D4). */
  superAdmin?: boolean;
}

/**
 * D4 approver rule: admin, or a manager who manages this site. `can_manage_rates`
 * is intentionally NOT an input — it can never unlock approval.
 */
export function canApprove(ctx: ApproverContext): boolean {
  return ctx.role === 'admin' || (ctx.role === 'manager' && ctx.managesSite);
}

/** An illegal invoice status transition was attempted. */
export class InvoiceTransitionError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly reason: 'not_draft' | 'not_approved' | 'already_void',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceTransitionError';
  }
}

/** The caller is not authorized to approve this invoice (D4). */
export class InvoiceApprovalForbiddenError extends Error {
  readonly status = 403 as const;
  constructor() {
    super(
      'approver must be an admin or the manager of this site (can_manage_rates is not sufficient)',
    );
    this.name = 'InvoiceApprovalForbiddenError';
  }
}

function windowISO(row: { window_start: Date; window_end: Date }): {
  startISO: string;
  endISO: string;
} {
  return {
    startISO: row.window_start.toISOString().slice(0, 10),
    endISO: row.window_end.toISOString().slice(0, 10),
  };
}

export interface ApproveArgs {
  siteId: string;
  invoiceId: string;
  approver: ApproverContext;
  /** Present iff a super-admin is overriding a blocked gate. */
  gateOverride?: { justification: string };
}

/**
 * Approve a draft invoice (the freeze). Enforces authorization, re-asserts the
 * total invariant, runs the trust gate (refuse or audited override), then flips
 * the row to `approved`. Approved rows are immutable thereafter.
 */
export async function approveInvoice(args: ApproveArgs): Promise<InvoiceView> {
  const row = await loadInvoiceRow(args.siteId, args.invoiceId);
  if (!row) throw new InvoiceNotFoundError(args.invoiceId);
  if (row.status === 'approved') throw new InvoiceImmutableError(row.id);
  if (row.status !== 'draft') {
    throw new InvoiceTransitionError(
      'not_draft',
      `invoice ${row.id} is ${row.status}; only a draft can be approved`,
    );
  }
  if (!canApprove(args.approver)) throw new InvoiceApprovalForbiddenError();

  // ADR-0033 tripwire: the stored total MUST reconcile to its lines at the freeze.
  assertTotalMatchesLines(
    row.id,
    row.total_cents,
    row.lines.map((l) => ({ amountCents: l.amount_cents })),
  );

  const { startISO, endISO } = windowISO(row);
  const gate = await evaluateWindowGate(prisma, args.siteId, startISO, endISO);

  let overrideNote: string | null = null;
  if (gate.blocked) {
    const justification = args.gateOverride?.justification?.trim();
    if (justification && args.approver.superAdmin) {
      const rec = await recordGateOverride({
        db: prisma,
        siteId: args.siteId,
        windowStartISO: startISO,
        windowEndISO: endISO,
        actorUserId: args.approver.userId,
        justification,
      });
      if (!rec.ok)
        throw new InvoiceGateBlockedError({
          siteId: args.siteId,
          windowStartISO: startISO,
          windowEndISO: endISO,
          findingCodes: gate.findingCodes,
        });
      overrideNote = justification;
      log.warn(
        {
          op: 'invoice.approve.override',
          site_id: args.siteId,
          invoice_id: row.id,
          finding_codes: gate.findingCodes,
          actor_user_id: args.approver.userId,
        },
        '[invoices] trust gate OVERRIDDEN by super-admin at approval',
      );
    } else {
      log.warn(
        {
          op: 'invoice.approve.refused',
          site_id: args.siteId,
          invoice_id: row.id,
          finding_count: gate.blockingFindings.length,
          finding_codes: gate.findingCodes,
        },
        '[invoices] approval refused — trust gate blocked',
      );
      throw new InvoiceGateBlockedError({
        siteId: args.siteId,
        windowStartISO: startISO,
        windowEndISO: endISO,
        findingCodes: gate.findingCodes,
      });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Atomic CAS on the status (same shape as credit-memos): a concurrent
    // void/approve that won the race makes this a 0-row update → typed 409,
    // never an approve-over-void.
    const claimed = await tx.invoice.updateMany({
      where: { id: row.id, status: 'draft' },
      data: {
        status: 'approved',
        approved_by: args.approver.userId,
        approved_at: new Date(),
        ...(overrideNote ? { gate_override_note: overrideNote } : {}),
      },
    });
    if (claimed.count === 0) {
      throw new InvoiceTransitionError(
        'not_draft',
        `invoice ${row.id} was transitioned concurrently; re-read before acting`,
      );
    }
    const u = await tx.invoice.findUniqueOrThrow({
      where: { id: row.id },
      include: { lines: true },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.approver.userId,
        action: 'update',
        table_name: TABLE,
        row_id: row.id,
        before: { status: 'draft' },
        after: {
          status: 'approved',
          total_cents: u.total_cents,
          gate_overridden: overrideNote != null,
          ...(overrideNote ? { override_finding_codes: gate.findingCodes } : {}),
        },
      },
    });
    return u;
  });

  log.info(
    {
      op: 'invoice.approve',
      site_id: args.siteId,
      invoice_id: row.id,
      total_cents: updated.total_cents,
      gate_overridden: overrideNote != null,
    },
    '[invoices] approved',
  );
  return toInvoiceView(updated);
}

export interface VoidArgs {
  siteId: string;
  invoiceId: string;
  actorUserId: string;
  reason?: string;
}

/**
 * Void an invoice (discard a draft, or cancel an approved one). Immutability
 * protects the NUMBERS (lines/total never change); the status lifecycle is an
 * append-only transition with an audit row.
 */
export async function voidInvoice(args: VoidArgs): Promise<InvoiceView> {
  const row = await loadInvoiceRow(args.siteId, args.invoiceId);
  if (!row) throw new InvoiceNotFoundError(args.invoiceId);
  if (row.status === 'void') {
    throw new InvoiceTransitionError('already_void', `invoice ${row.id} is already void`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Atomic CAS on the status this call observed (a concurrent approve/void
    // loses cleanly with a typed 409). The reason APPENDS to notes — the
    // generation note is part of the audit trail, never overwritten.
    const claimed = await tx.invoice.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: 'void',
        voided_by: args.actorUserId,
        voided_at: new Date(),
        ...(args.reason
          ? { notes: row.notes ? `${row.notes}\n[void] ${args.reason}` : `[void] ${args.reason}` }
          : {}),
      },
    });
    if (claimed.count === 0) {
      throw new InvoiceTransitionError(
        'already_void',
        `invoice ${row.id} was transitioned concurrently; re-read before acting`,
      );
    }
    const u = await tx.invoice.findUniqueOrThrow({
      where: { id: row.id },
      include: { lines: true },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: row.id,
        before: { status: row.status },
        after: { status: 'void', ...(args.reason ? { reason: args.reason } : {}) },
      },
    });
    return u;
  });

  log.info(
    { op: 'invoice.void', site_id: args.siteId, invoice_id: row.id, prior_status: row.status },
    '[invoices] voided',
  );
  return toInvoiceView(updated);
}

export interface SupersedeArgs {
  siteId: string;
  invoiceId: string;
  actorUserId: string;
  /** OR collection-site-count supersede: the re-entered manual lines. */
  manualLines?: readonly ManualLine[];
  notes?: string;
}

/**
 * Supersede an APPROVED invoice: regenerate a fresh draft in the same (site,
 * kind, month) chain at the next version, `supersedes_id` pointing at the
 * approved row. The approved row STAYS approved (both retained); the new draft
 * then goes through approval. Only an approved invoice can be superseded.
 */
export async function supersedeInvoice(args: SupersedeArgs): Promise<InvoiceView> {
  const row = await loadInvoiceRow(args.siteId, args.invoiceId);
  if (!row) throw new InvoiceNotFoundError(args.invoiceId);
  if (row.status !== 'approved') {
    throw new InvoiceTransitionError(
      'not_approved',
      `invoice ${row.id} is ${row.status}; only an approved invoice can be superseded`,
    );
  }

  const draft = await generateInvoiceDraft({
    siteId: args.siteId,
    kind: row.kind,
    billingMonthISO: row.billing_month.toISOString().slice(0, 10),
    actorUserId: args.actorUserId,
    supersedesId: row.id,
    ...(args.manualLines ? { manualLines: args.manualLines } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
  });

  log.info(
    {
      op: 'invoice.supersede',
      site_id: args.siteId,
      superseded_id: row.id,
      new_invoice_id: draft.id,
      new_version: draft.version,
    },
    '[invoices] superseded — new draft version created',
  );
  return draft;
}
