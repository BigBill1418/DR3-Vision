// ADR-0052 — commodity payment reconciliation list. Org reach only (admin OR
// all_sites manager — Daven's mechanism); both sites in one response.

import { NextResponse } from 'next/server';
import type { CommodityPaymentStatus } from '@prisma/client';
import { requireOrgReach } from '@/lib/ops/viewer';
import { listCommodityPayments } from '@/lib/commodity-payments/payments';

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
    return NextResponse.json({ rows });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
