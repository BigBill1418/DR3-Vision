// ADR-0041 D4/D5 — invoice export: `?format=xlsx` (Summary workbook) or
// `?format=json` (the neutral `invoice_export` GP boundary). Site-scoped.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { getInvoiceDetail } from '@/lib/invoices/service';
import { renderInvoiceXlsxBuffer } from '@/lib/invoices/render-xlsx';
import { invoiceExportV1 } from '@/lib/invoices/export-json';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const detail = await getInvoiceDetail(ctx.siteId, id);
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const format = new URL(req.url).searchParams.get('format') ?? 'json';

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
    return NextResponse.json(invoiceExportV1(detail.invoice));
  } catch (e) {
    return invoiceErrorResponse(e, { site, id, op: 'invoices.export', requestId: req.headers.get('x-request-id') });
  }
}
