// ADR-0041 D4/D5 — invoice export: `?format=xlsx` (Summary workbook) or
// `?format=json` (the neutral `invoice_export` GP boundary). Site-scoped.
//
// The JSON boundary is versioned (ADR-0041 amendment §4.2, C-1 bump): `?v=1`
// (default — the FROZEN v1 contract, unchanged) or `?v=2` (the two-line GP
// export carrying the trade-discount fields + GP identifiers). v1 stays the
// default so no existing consumer's shape changes.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { getInvoiceDetail } from '@/lib/invoices/service';
import { renderInvoiceXlsxBuffer } from '@/lib/invoices/render-xlsx';
import { invoiceExportV1, invoiceExportV2 } from '@/lib/invoices/export-json';
import { resolveGpExportContext } from '@/lib/invoices/gp-config';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const detail = await getInvoiceDetail(ctx.siteId, id);
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const params = new URL(req.url).searchParams;
    const format = params.get('format') ?? 'json';

    if (format === 'xlsx') {
      const buf = await renderInvoiceXlsxBuffer(detail.invoice);
      const name = `invoice-${detail.invoice.kind}-${detail.invoice.billingMonth.toISOString().slice(0, 7)}-v${detail.invoice.version}.xlsx`;
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${name}"`,
        },
      });
    }
    // JSON: v1 (default, frozen) or v2 (two-line GP export). v2 resolves the GP
    // header context (Bill-To / Customer ID / PO / Sales ID / Payment Terms).
    if (params.get('v') === '2') {
      const gpCtx = await resolveGpExportContext(detail.invoice);
      return NextResponse.json(invoiceExportV2(detail.invoice, gpCtx));
    }
    return NextResponse.json(invoiceExportV1(detail.invoice));
  } catch (e) {
    return invoiceErrorResponse(e, { site, id, op: 'invoices.export', requestId: req.headers.get('x-request-id') });
  }
}
