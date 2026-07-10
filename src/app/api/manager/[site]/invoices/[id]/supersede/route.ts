// ADR-0041 D1 — supersede an approved invoice: regenerate a new draft version in
// the same chain (both retained). The new draft then goes through approval.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { supersedeInvoice } from '@/lib/invoices/lifecycle';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ManualLine = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().finite().nullable().optional(),
  // Negative lines are legitimate (offsets); magnitude is bounded so a typo'd
  // −$1,000,000 manual line cannot compose cleanly ($500k cap, generous vs any
  // real OR collection-site amount).
  amountCents: z.number().int().gte(-50_000_000).lte(50_000_000),
});

const Supersede = z.object({
  manualLines: z.array(ManualLine).max(500).optional(),
  notes: z.string().max(1000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Supersede.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const invoice = await supersedeInvoice({
      siteId: ctx.siteId,
      invoiceId: id,
      actorUserId: ctx.userId,
      ...(parsed.data.manualLines
        ? {
            manualLines: parsed.data.manualLines.map((m) => ({
              description: m.description,
              quantity: m.quantity ?? null,
              amountCents: m.amountCents,
            })),
          }
        : {}),
      ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
    });
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (e) {
    return invoiceErrorResponse(e, {
      site,
      id,
      op: 'invoices.supersede',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
