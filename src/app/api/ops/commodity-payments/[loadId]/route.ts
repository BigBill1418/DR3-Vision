// ADR-0052 — create/update the payment record for one outbound load. Org reach
// only. Transitions are validated forward-only; every change is audited.

import { NextResponse } from 'next/server';
import type { CommodityPaymentStatus } from '@prisma/client';
import { requireOrgReach } from '@/lib/ops/viewer';
import {
  CommodityLoadNotFoundError,
  CommodityPaymentInputError,
  CommodityPaymentTransitionError,
  upsertPaymentRecord,
  type PaymentPatch,
} from '@/lib/commodity-payments/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: ReadonlySet<string> = new Set(['awaiting_invoice', 'invoiced', 'paid', 'disputed']);

interface Body {
  status?: string;
  buyerInvoiceRef?: string | null;
  expectedAmount?: string | null;
  invoicedAtISO?: string | null;
  paidAtISO?: string | null;
  notes?: string | null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ loadId: string }> },
): Promise<Response> {
  try {
    const identity = await requireOrgReach();
    const { loadId } = await params;
    const body = (await req.json().catch(() => ({}))) as Body;
    if (body.status !== undefined && !STATUSES.has(body.status)) {
      return NextResponse.json(
        { error: "status must be one of 'awaiting_invoice', 'invoiced', 'paid', 'disputed'" },
        { status: 400 },
      );
    }
    const patch: PaymentPatch = {
      ...(body.status !== undefined ? { status: body.status as CommodityPaymentStatus } : {}),
      ...(body.buyerInvoiceRef !== undefined ? { buyerInvoiceRef: body.buyerInvoiceRef } : {}),
      ...(body.expectedAmount !== undefined ? { expectedAmount: body.expectedAmount } : {}),
      ...(body.invoicedAtISO !== undefined ? { invoicedAtISO: body.invoicedAtISO } : {}),
      ...(body.paidAtISO !== undefined ? { paidAtISO: body.paidAtISO } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    };
    const row = await upsertPaymentRecord({
      outboundMaterialId: loadId,
      actorUserId: identity.userId,
      patch,
    });
    return NextResponse.json({ ok: true, status: row.status });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof CommodityPaymentTransitionError || e instanceof CommodityPaymentInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof CommodityLoadNotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    throw e;
  }
}
