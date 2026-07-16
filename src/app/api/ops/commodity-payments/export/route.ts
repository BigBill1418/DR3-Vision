// ADR-0052 — CSV export of the (filtered) commodity payment view. Org reach only.

import type { CommodityPaymentStatus } from '@prisma/client';
import { requireOrgReach } from '@/lib/ops/viewer';
import { listCommodityPayments, paymentsToCsv } from '@/lib/commodity-payments/payments';
import { pacificDayISO } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: ReadonlySet<string> = new Set(['awaiting_invoice', 'invoiced', 'paid', 'disputed']);

export async function GET(req: Request): Promise<Response> {
  try {
    await requireOrgReach();
    const url = new URL(req.url);
    const siteId = url.searchParams.get('site') ?? undefined;
    const statusRaw = url.searchParams.get('status') ?? 'all';
    const status = STATUSES.has(statusRaw) ? (statusRaw as CommodityPaymentStatus) : 'all';
    const rows = await listCommodityPayments({ ...(siteId ? { siteId } : {}), status });
    const csv = paymentsToCsv(rows);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="commodity-payments-${pacificDayISO()}.csv"`,
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
