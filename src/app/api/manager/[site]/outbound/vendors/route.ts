// ADR-0055 — active outbound recyclers for the iPad entry-surface vendor picker.

import { NextResponse } from 'next/server';
import { listActiveOutboundVendors } from '@/lib/loads/recycling-rates';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    await requireActivatedManager(site);
    return NextResponse.json({ vendors: await listActiveOutboundVendors() });
  } catch (e) {
    return loadsErrorResponse(e, { site, op: 'outbound.vendors', requestId: req.headers.get('x-request-id') });
  }
}
