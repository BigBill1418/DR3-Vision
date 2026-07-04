// ADR-0042 D3 — COR PDF: POST regenerates + uploads the artifact (reconcile
// tripwire enforced); GET mints a short-lived presigned download URL. Site-scoped.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { loadCorRow } from '@/lib/cor/service';
import { generateCorPdf, corPdfDownloadUrl } from '@/lib/cor/pdf';
import { corErrorResponse } from '@/lib/cor/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — presigned download URL for the stored PDF (404 if none rendered yet). */
export async function GET(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    // Site-scope the certificate before minting a URL (hard rule #2).
    const row = await loadCorRow(ctx.siteId, id);
    if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const url = await corPdfDownloadUrl(id);
    if (!url) return NextResponse.json({ error: 'no_pdf' }, { status: 404 });
    return NextResponse.json({ url });
  } catch (e) {
    return corErrorResponse(e, { site, id, op: 'cor.pdf.download', requestId: req.headers.get('x-request-id') });
  }
}

/** POST — (re)generate the PDF. Refuses on a reconcile mismatch (both numbers). */
export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const row = await loadCorRow(ctx.siteId, id);
    if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const { storageKey } = await generateCorPdf(id);
    return NextResponse.json({ storageKey });
  } catch (e) {
    return corErrorResponse(e, { site, id, op: 'cor.pdf.generate', requestId: req.headers.get('x-request-id') });
  }
}
