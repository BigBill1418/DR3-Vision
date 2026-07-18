// ADR-0041 amendment §3.4 — flip a (site, kind) between pilot and production.
//
// GET returns the current mode config for every kind at the site; POST flips one
// (site, kind). Authorized like approval (D4): admin, or the manager OF this site
// — `can_manage_rates` is never sufficient (`canApprove` doesn't consult it).
// Graduating to production is the deliberate, audited act that lets that (site,
// kind)'s future invoices reach MRC.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { canApprove } from '@/lib/invoices/lifecycle';
import { setInvoiceMode } from '@/lib/invoices/gp-config';
import { invoiceErrorResponse, resolveApprover } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = [
  'ca_processing_mid_month',
  'ca_processing_eom',
  'ca_transportation_eom',
  'or_processing_eom',
  'or_transportation_eom',
  'or_collection_site_count',
] as const;

const SetMode = z.object({
  kind: z.enum(KINDS),
  mode: z.enum(['pilot', 'production']),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const rows = await prisma.invoiceModeConfig.findMany({
      where: { site_id: ctx.siteId },
      select: { kind: true, mode: true, updated_at: true },
    });
    const configured = new Map(rows.map((r) => [r.kind, r]));
    // No row ⇒ pilot (the safe default). Report every kind explicitly.
    const modes = KINDS.map((kind) => ({
      kind,
      mode: configured.get(kind)?.mode ?? 'pilot',
      updatedAt: configured.get(kind)?.updated_at ?? null,
    }));
    return NextResponse.json({ modes });
  } catch (e) {
    return invoiceErrorResponse(e, { site, op: 'invoices.mode.get', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const approver = await resolveApprover(ctx.siteId);
    if (!canApprove(approver)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const parsed = SetMode.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const mode = await setInvoiceMode({
      siteId: ctx.siteId,
      kind: parsed.data.kind,
      mode: parsed.data.mode,
      actorUserId: approver.userId,
    });
    return NextResponse.json({ kind: parsed.data.kind, mode });
  } catch (e) {
    return invoiceErrorResponse(e, { site, op: 'invoices.mode.set', requestId: req.headers.get('x-request-id') });
  }
}
