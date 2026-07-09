// ADR-0046 D4 — AP queue read models (list + detail).
//
// The detail view exposes `bodyHtmlSanitized` (already allowlist-sanitized at
// ingest) for the sandboxed-iframe render, `bodyText`, attachments (file storage
// keys / reference links / nested-message markers), and follow-ups. Reference
// links are surfaced but NEVER fetched by Vision.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';

export type ApStatus = 'pending' | 'pending_review' | 'approved' | 'rejected' | 'quarantined';

export interface ApListRow {
  id: string;
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
  attachments: ApAttachmentView[];
  followups: Array<{ id: string; receivedAt: string; senderAddress: string; bodyText: string | null }>;
}

const LIST_STATUSES = ['pending', 'pending_review', 'approved', 'rejected', 'quarantined'] as const;
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
    new Set(rows.filter((r) => r.status === 'pending_review' && r.held_by).map((r) => r.held_by as string)),
  );
  const holderNames = new Map<string, string>();
  if (holderIds.length > 0) {
    const users = await prisma.user.findMany({ where: { id: { in: holderIds } }, select: { id: true, name: true } });
    for (const u of users) holderNames.set(u.id, u.name);
  }
  const counts: Record<string, number> = {
    pending: 0,
    pending_review: 0,
    approved: 0,
    rejected: 0,
    quarantined: 0,
  };
  for (const g of grouped) counts[g.status] = g._count._all;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      status: r.status,
      subject: r.subject,
      senderAddress: r.sender_address,
      senderValidated: r.sender_validated,
      receivedAt: r.received_at.toISOString(),
      vendor: r.vendor,
      amountCents: r.amount_cents,
      attachmentCount: r._count.attachments,
      followupCount: r._count.followups,
      heldByName: r.status === 'pending_review' && r.held_by ? holderNames.get(r.held_by) ?? null : null,
      holdNote: r.status === 'pending_review' ? r.hold_note : null,
    })),
    counts,
  };
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
    },
  });
  if (!r) return null;
  const decidedByName = r.decided_by
    ? (await prisma.user.findUnique({ where: { id: r.decided_by }, select: { name: true } }))?.name ?? null
    : null;
  const heldByName = r.held_by
    ? (await prisma.user.findUnique({ where: { id: r.held_by }, select: { name: true } }))?.name ?? null
    : null;
  return {
    id: r.id,
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
