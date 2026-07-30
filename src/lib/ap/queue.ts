// ADR-0046 D4 — AP queue read models (list + detail).
//
// The detail view exposes `bodyHtmlSanitized` (already allowlist-sanitized at
// ingest) for the sandboxed-iframe render, `bodyText`, attachments (file storage
// keys / reference links / nested-message markers), and follow-ups. Reference
// links are surfaced but NEVER fetched by Vision.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import type { ExtractionConfidence, ExtractionResult } from './extraction/types';

export type ApStatus =
  | 'pending'
  | 'pending_review'
  // ADR-0046 Amendment 5 (D-M5-3) — dual-approval hop (>= $1,000). Mirrors the
  // Prisma ApRequestStatus enum so the read models type-check.
  | 'pending_second_approval'
  | 'approved'
  | 'rejected'
  | 'quarantined';

export interface ApListRow {
  id: string;
  /**
   * ADR-0068 Amendment 3 — what KIND of thing this row is.
   *
   * The queue is one worklist over two different objects. A discriminant rather
   * than a nullable field so the client cannot render a reimbursement through the
   * vendor-invoice panel by forgetting a check: the Amendment 5 structured Approve
   * panel, baseline variance, equipment linking and amount auto-extraction are all
   * vendor-invoice constructs and must never be applied to a reimbursement (D7).
   *
   * Absent/`'invoice'` on every pre-existing row, so nothing that reads this list
   * changes behaviour until it opts in.
   */
  kind: 'invoice' | 'reimbursement';
  status: ApStatus;
  subject: string | null;
  senderAddress: string;
  senderValidated: boolean;
  receivedAt: string;
  vendor: string | null;
  amountCents: number | null;
  attachmentCount: number;
  followupCount: number;
  /** Amendment 3 — hold record (present iff status=pending_review). */
  heldByName: string | null;
  holdNote: string | null;
  /**
   * Reimbursement-only. Bill 2026-07-30: reimbursements are work materials, tools
   * and equipment only — never medical or otherwise sensitive — so the beneficiary
   * and purpose are safe to show org-wide alongside invoices. That is a POLICY
   * about what the field contains, so the form tells submitters the audience.
   */
  reimbursement: {
    siteCode: string;
    siteName: string;
    beneficiary: string;
    submitterName: string;
    routedToName: string;
    purpose: string;
    category: string;
    escalated: boolean;
    /** Deep link to the site surface where it can actually be decided. */
    url: string;
  } | null;
}

export interface ApAttachmentView {
  id: string;
  kind: 'file' | 'nested_message' | 'reference_link';
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  storageKey: string | null;
  linkUrl: string | null;
  nestedSubject: string | null;
}

/** ADR-0046 Amendment 5 (D-M5-2) — the extraction pre-fill surfaced to the panel:
 * the best-guess amount/vendor + confidence tier (the badge). Null when the row has
 * no extraction (pre-Amendment-5 rows). */
export interface ApExtractionPrefill {
  confidence: ExtractionConfidence;
  bestAmountCents: number | null;
  bestVendor: string | null;
}

/** ADR-0046 Amendment 5 (D-M5-6) — one recorded equipment link on a decided row. */
export interface ApEquipmentLinkView {
  equipmentId: string | null;
  displayName: string | null;
  isNotEquipmentRelated: boolean;
  /**
   * Amendment 9 (§2.2) — the escape-hatch request this link points at, if any.
   * `description` is what the approver wrote; `status` says whether a site manager
   * has acted on it yet. Surfaced on read-back so a decided invoice shows WHY it
   * has no registry asset, rather than looking like an empty equipment record.
   */
  equipmentRequest: { id: string; description: string; status: string } | null;
}

export interface ApDetailView extends ApListRow {
  conversationId: string | null;
  bodyHtmlSanitized: string | null;
  bodyText: string | null;
  quarantineReason: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decisionMailSentAt: string | null;
  /** Amendment 3 — hold record. */
  heldAt: string | null;
  holdNote: string | null;
  // ─── ADR-0046 Amendment 5 (D-M5-1/2/4/6) — structured decide surface.
  /** D-M5-2 — extraction pre-fill for the confirmed-amount input + confidence badge. */
  extraction: ApExtractionPrefill | null;
  /** D-M5-1 — structured Approve values (present on Amendment-5 approved rows). */
  vendorFreeform: string | null;
  explanation: string | null;
  confirmedAmountCents: number | null;
  /** D-M5-4 — variance flag state stamped at decide. */
  varianceFlagState: string | null;
  varianceAcknowledgmentNote: string | null;
  /** D-M5-6 — equipment linkage recorded on a decided row (for read-back). */
  equipmentLinks: ApEquipmentLinkView[];
  // ─── ADR-0046 Amendment 5 (D-M5-3) — dual-approval read surface. Present on a
  // >= $1,000 request (awaiting or after second approval); null otherwise.
  firstApproverId: string | null;
  firstApproverName: string | null;
  firstApprovedAt: string | null;
  secondApproverId: string | null;
  secondApproverName: string | null;
  secondApprovedAt: string | null;
  secondApproverNote: string | null;
  attachments: ApAttachmentView[];
  followups: Array<{
    id: string;
    receivedAt: string;
    senderAddress: string;
    bodyText: string | null;
  }>;
}

/** Narrow the persisted `extraction` JSONB to the pre-fill the panel needs. Tolerant
 * of a malformed/legacy blob (returns null rather than throwing). */
function toExtractionPrefill(raw: unknown): ApExtractionPrefill | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<ExtractionResult>;
  if (typeof e.confidence !== 'string') return null;
  return {
    confidence: e.confidence as ExtractionConfidence,
    bestAmountCents: typeof e.best_amount_cents === 'number' ? e.best_amount_cents : null,
    bestVendor: typeof e.best_vendor === 'string' ? e.best_vendor : null,
  };
}

const LIST_STATUSES = [
  'pending',
  'pending_review',
  // D-M5-3 — the $1,000 second-approval queue (a distinct tab for second approvers).
  'pending_second_approval',
  'approved',
  'rejected',
  'quarantined',
] as const;
export type ApListFilter = (typeof LIST_STATUSES)[number] | 'all';

export function isApListFilter(v: string | null): v is ApListFilter {
  return v === 'all' || (v !== null && (LIST_STATUSES as readonly string[]).includes(v));
}

export async function listApRequests(
  filter: ApListFilter = 'pending',
  prisma: PrismaClient = defaultPrisma,
): Promise<{ rows: ApListRow[]; counts: Record<string, number> }> {
  const where = filter === 'all' ? {} : { status: filter };
  const [rows, grouped] = await Promise.all([
    prisma.apRequest.findMany({
      where,
      orderBy: { received_at: 'desc' },
      select: {
        id: true,
        status: true,
        subject: true,
        sender_address: true,
        sender_validated: true,
        received_at: true,
        vendor: true,
        amount_cents: true,
        held_by: true,
        hold_note: true,
        _count: { select: { attachments: true, followups: true } },
      },
    }),
    prisma.apRequest.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  // Batch-resolve holder names for on-hold rows (avoids N+1).
  const holderIds = Array.from(
    new Set(
      rows
        .filter((r) => r.status === 'pending_review' && r.held_by)
        .map((r) => r.held_by as string),
    ),
  );
  const holderNames = new Map<string, string>();
  if (holderIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: holderIds } },
      select: { id: true, name: true },
    });
    for (const u of users) holderNames.set(u.id, u.name);
  }
  const counts: Record<string, number> = {
    pending: 0,
    pending_review: 0,
    pending_second_approval: 0,
    approved: 0,
    rejected: 0,
    quarantined: 0,
  };
  for (const g of grouped) counts[g.status] = g._count._all;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      kind: 'invoice' as const,
      status: r.status,
      subject: r.subject,
      senderAddress: r.sender_address,
      senderValidated: r.sender_validated,
      receivedAt: r.received_at.toISOString(),
      vendor: r.vendor,
      amountCents: r.amount_cents,
      attachmentCount: r._count.attachments,
      followupCount: r._count.followups,
      heldByName:
        r.status === 'pending_review' && r.held_by ? (holderNames.get(r.held_by) ?? null) : null,
      holdNote: r.status === 'pending_review' ? r.hold_note : null,
      reimbursement: null,
    })),
    counts,
  };
}

/**
 * ADR-0068 Amendment 3 — reimbursements awaiting a second signature, shaped for
 * the AP queue.
 *
 * ── Why they are visible org-wide, on the record ────────────────────────────
 * The privacy question was raised BEFORE building this, because the AP queue has
 * no site filter and gates on roster membership: interleaving means an approver at
 * one site can read a reimbursement filed at the other. Bill answered it directly
 * on 2026-07-30: *"the reimbursement are NEVER medical or anything sensitive its
 * only work related materials and tools or equipment."* That is a policy statement
 * about what the `purpose` field contains, so it is honoured here AND surfaced to
 * submitters on the form — a policy that nobody is told about stops being true.
 *
 * ── What this does NOT do ──────────────────────────────────────────────────
 * It does not make the queue a place to DECIDE a reimbursement. Only one person can
 * act on any given one (`canApproveReimbursement` hard-stops the submitter and the
 * beneficiary, and confines a non-admin without `all_sites` to their own site), so
 * every row deep-links to the site surface where the real, server-authorised
 * decision happens. Adding a second decision path here would put the control in
 * two places, which is how it drifts.
 */
export async function listReimbursementQueueRows(
  prisma: PrismaClient = defaultPrisma,
): Promise<ApListRow[]> {
  const rows = await prisma.reimbursementRequest.findMany({
    where: { status: 'pending_second_approval' },
    orderBy: { submitted_at: 'desc' },
    select: {
      id: true,
      amount_cents: true,
      submitted_at: true,
      purpose: true,
      category: true,
      escalated_at: true,
      employee_name_freeform: true,
      employee_user: { select: { name: true } },
      submitter: { select: { name: true } },
      routed_to: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });

  return rows.map((r) => {
    const beneficiary = r.employee_user?.name ?? r.employee_name_freeform ?? '(unnamed)';
    return {
      id: r.id,
      kind: 'reimbursement' as const,
      status: 'pending_second_approval' as ApStatus,
      subject: `Reimbursement — ${beneficiary}`,
      // A reimbursement has no sender: it was FILED in Vision by an authenticated
      // manager, not forwarded from a mailbox. Naming the submitter here is the
      // honest analogue, and `senderValidated` is true because an authenticated
      // submission is the strongest provenance in the queue.
      senderAddress: `filed by ${r.submitter.name}`,
      senderValidated: true,
      receivedAt: r.submitted_at.toISOString(),
      vendor: null, // there is no vendor — an insider is being repaid
      amountCents: r.amount_cents,
      attachmentCount: 1, // the receipt is REQUIRED, so there is always exactly one
      followupCount: 0,
      heldByName: null,
      holdNote: null,
      reimbursement: {
        siteCode: r.site.code,
        siteName: r.site.name,
        beneficiary,
        submitterName: r.submitter.name,
        routedToName: r.routed_to.name,
        purpose: r.purpose,
        category: r.category,
        escalated: r.escalated_at != null,
        url: `/dashboard/${r.site.code}/reimbursements`,
      },
    };
  });
}

export async function getApRequestDetail(
  id: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<ApDetailView | null> {
  const r = await prisma.apRequest.findUnique({
    where: { id },
    include: {
      attachments: { orderBy: { created_at: 'asc' } },
      followups: { orderBy: { received_at: 'asc' } },
      // Amendment 5 (D-M5-6) — equipment linkage recorded on a decided row.
      equipment_links: {
        include: {
          equipment: { select: { display_name: true } },
          // Amendment 9 — the escape-hatch request behind a hatch link.
          equipment_request: { select: { id: true, description: true, status: true } },
        },
      },
    },
  });
  if (!r) return null;
  const decidedByName = r.decided_by
    ? ((await prisma.user.findUnique({ where: { id: r.decided_by }, select: { name: true } }))
        ?.name ?? null)
    : null;
  const heldByName = r.held_by
    ? ((await prisma.user.findUnique({ where: { id: r.held_by }, select: { name: true } }))?.name ??
      null)
    : null;
  // D-M5-3 — resolve the dual-approval identities for the second-approval panel +
  // read-back. Only queried when present (a >= $1,000 request).
  const firstApproverName = r.first_approver_id
    ? ((
        await prisma.user.findUnique({ where: { id: r.first_approver_id }, select: { name: true } })
      )?.name ?? null)
    : null;
  const secondApproverName = r.second_approver_id
    ? ((
        await prisma.user.findUnique({
          where: { id: r.second_approver_id },
          select: { name: true },
        })
      )?.name ?? null)
    : null;
  return {
    id: r.id,
    // `getApRequestDetail` reads `ap_requests` only, so a detail view is ALWAYS an
    // invoice. A reimbursement's detail lives on its own site surface, where the
    // authorisation check that governs it also lives (ADR-0068 Amendment 3).
    kind: 'invoice' as const,
    reimbursement: null,
    status: r.status,
    subject: r.subject,
    senderAddress: r.sender_address,
    senderValidated: r.sender_validated,
    receivedAt: r.received_at.toISOString(),
    vendor: r.vendor,
    amountCents: r.amount_cents,
    attachmentCount: r.attachments.length,
    followupCount: r.followups.length,
    heldByName,
    conversationId: r.conversation_id,
    bodyHtmlSanitized: r.body_html_sanitized,
    bodyText: r.body_text,
    quarantineReason: r.quarantine_reason,
    decidedBy: r.decided_by,
    decidedByName,
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    decisionNote: r.decision_note,
    decisionMailSentAt: r.decision_mail_sent_at ? r.decision_mail_sent_at.toISOString() : null,
    heldAt: r.held_at ? r.held_at.toISOString() : null,
    holdNote: r.hold_note,
    extraction: toExtractionPrefill(r.extraction),
    vendorFreeform: r.vendor_freeform,
    explanation: r.explanation,
    confirmedAmountCents: r.confirmed_amount_cents,
    varianceFlagState: r.variance_flag_state,
    varianceAcknowledgmentNote: r.variance_acknowledgment_note,
    equipmentLinks: r.equipment_links.map((l) => ({
      equipmentId: l.equipment_id,
      displayName: l.equipment?.display_name ?? null,
      isNotEquipmentRelated: l.is_not_equipment_related,
      equipmentRequest: l.equipment_request
        ? {
            id: l.equipment_request.id,
            description: l.equipment_request.description,
            status: l.equipment_request.status,
          }
        : null,
    })),
    firstApproverId: r.first_approver_id,
    firstApproverName,
    firstApprovedAt: r.first_approved_at ? r.first_approved_at.toISOString() : null,
    secondApproverId: r.second_approver_id,
    secondApproverName,
    secondApprovedAt: r.second_approved_at ? r.second_approved_at.toISOString() : null,
    secondApproverNote: r.second_approver_note,
    attachments: r.attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      filename: a.filename,
      contentType: a.content_type,
      byteSize: a.byte_size,
      storageKey: a.storage_key,
      linkUrl: a.link_url,
      nestedSubject: a.nested_subject,
    })),
    followups: r.followups.map((f) => ({
      id: f.id,
      receivedAt: f.received_at.toISOString(),
      senderAddress: f.sender_address,
      bodyText: f.body_text,
    })),
  };
}
