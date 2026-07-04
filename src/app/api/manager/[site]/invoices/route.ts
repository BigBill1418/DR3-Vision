// ADR-0041 — manager invoices API: list + generate (draft). Site-scoped.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { generateInvoiceDraft, listInvoices } from '@/lib/invoices/service';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

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

const ManualLine = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().finite().nullable().optional(),
  amountCents: z.number().int(),
});

const Generate = z.object({
  kind: z.enum(KINDS),
  billingMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  manualLines: z.array(ManualLine).max(500).optional(),
  notes: z.string().max(1000).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const url = new URL(req.url);
    const kind = url.searchParams.get('kind');
    const billingMonth = url.searchParams.get('billingMonth');
    const rows = await listInvoices(ctx.siteId, {
      ...(kind && (KINDS as readonly string[]).includes(kind) ? { kind: kind as (typeof KINDS)[number] } : {}),
      ...(billingMonth ? { billingMonthISO: `${billingMonth}${billingMonth.length === 7 ? '-01' : ''}` } : {}),
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return invoiceErrorResponse(e, { site, op: 'invoices.list', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Generate.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const billingMonthISO = d.billingMonth.length === 7 ? `${d.billingMonth}-01` : d.billingMonth;
    const invoice = await generateInvoiceDraft({
      siteId: ctx.siteId,
      kind: d.kind,
      billingMonthISO,
      actorUserId: ctx.userId,
      ...(d.manualLines
        ? { manualLines: d.manualLines.map((m) => ({ description: m.description, quantity: m.quantity ?? null, amountCents: m.amountCents })) }
        : {}),
      ...(d.notes ? { notes: d.notes } : {}),
    });
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (e) {
    return invoiceErrorResponse(e, { site, op: 'invoices.generate', requestId: req.headers.get('x-request-id') });
  }
}
