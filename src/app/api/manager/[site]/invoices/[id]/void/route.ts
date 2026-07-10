// ADR-0041 — void an invoice (discard a draft, or cancel an approved one).
//
// GATE ASYMMETRY FIX (2026-07-10 audit): cancelling an APPROVED invoice is the
// destructive half of the D4 approval decision, so it requires the SAME
// approver rule (admin or manager-of-this-site) — an all-sites manager has
// reach but not approval authority (route-helpers.ts), and previously could
// void any site's approved invoice. Discarding a DRAFT stays reach-gated
// (drafts regenerate freely; discarding one is not a money decision).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { canApprove, voidInvoice, InvoiceApprovalForbiddenError } from '@/lib/invoices/lifecycle';
import { invoiceErrorResponse, resolveApprover } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Void = z.object({ reason: z.string().max(1000).optional() });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Void.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const current = await prisma.invoice.findFirst({
      where: { id, site_id: ctx.siteId },
      select: { status: true },
    });
    if (current?.status === 'approved') {
      const approver = await resolveApprover(ctx.siteId);
      if (!canApprove(approver)) throw new InvoiceApprovalForbiddenError();
    }
    const invoice = await voidInvoice({
      siteId: ctx.siteId,
      invoiceId: id,
      actorUserId: ctx.userId,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    });
    return NextResponse.json({ invoice });
  } catch (e) {
    return invoiceErrorResponse(e, {
      site,
      id,
      op: 'invoices.void',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
