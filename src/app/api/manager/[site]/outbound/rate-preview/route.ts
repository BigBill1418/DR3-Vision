// ADR-0055 — recycling-rate split PREVIEW for the iPad outbound entry surface.
//
// The operator selects vendor + commodity (+ the load weight) and sees the
// recycled/landfilled split BEFORE saving. This wires the same effective-dated
// resolver + derivation the entry path uses, so the preview and the persisted
// row can never disagree. Read-only; never writes.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deriveOutboundRecycling } from '@/lib/loads/recycling-rates';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMMODITIES = [
  'trash', 'toppers', 'foam', 'metal', 'wood', 'cardboard', 'plastic', 'shoddy', 'cotton',
] as const;

const Query = z.object({
  vendorId: z.string().uuid(),
  commodity: z.enum(COMMODITIES),
  weightLbs: z.coerce.number().int().nonnegative().max(10_000_000),
  // Optional; the effective date the rate resolves on. Defaults to today (UTC).
  shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    await requireActivatedManager(site);
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      vendorId: url.searchParams.get('vendorId'),
      commodity: url.searchParams.get('commodity'),
      weightLbs: url.searchParams.get('weightLbs'),
      shipDate: url.searchParams.get('shipDate') ?? undefined,
    });
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const shipDate = d.shipDate ? new Date(`${d.shipDate}T00:00:00Z`) : new Date();
    const result = await deriveOutboundRecycling({
      vendorId: d.vendorId,
      commodity: d.commodity,
      shipDate,
      weightLbs: d.weightLbs,
    });
    return NextResponse.json({ preview: result });
  } catch (e) {
    return loadsErrorResponse(e, { site, op: 'outbound.rate-preview', requestId: req.headers.get('x-request-id') });
  }
}
