// Sprint-1 T-013 - SVdP Internal CSV export.
//
// GET /api/exports/svdp?site=eugene|woodland&month=YYYY-MM
//
// Per ADR-0012 section 7, ships with the MyMRC field-name shape plus
// four DR3-side provenance columns (DR3 Load ID, Arrived At, Unload
// Duration (s), Operator). Glenn DePrater CFO conversation will
// re-shape this in a Sprint-2+ follow-up ticket.
//
// Same auth + filter contract as /api/exports/mrc.

import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireManagerForSite } from '@/lib/auth-helpers';
import {
  buildSvdpRow,
  loadColumnsForSvdp,
  monthRange,
  toCsv,
  INVOICE_STATUSES,
  type LoadRowInput,
} from '@/lib/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  site: z.enum(['eugene', 'woodland']),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    site: url.searchParams.get('site'),
    month: url.searchParams.get('month'),
  });
  if (!parsed.success) {
    return new Response('invalid request: site=eugene|woodland & month=YYYY-MM required', {
      status: 400,
    });
  }

  let ctx;
  try {
    ctx = await requireManagerForSite(parsed.data.site);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let range: { start: Date; end: Date };
  try {
    range = monthRange(parsed.data.month);
  } catch {
    return new Response('invalid month', { status: 400 });
  }

  // CLAUDE.md hard-rule #2: site_id-scoped, period-bounded.
  const loads = await prisma.inboundLoad.findMany({
    where: {
      site_id: ctx.siteId,
      status: { in: [...INVOICE_STATUSES] },
      arrived_at: { gte: range.start, lt: range.end },
    },
    select: {
      id: true,
      external_mymrc_haul_id: true,
      bol_number: true,
      arrived_at: true,
      unload_finished_at: true,
      unload_duration_seconds: true,
      total_units: true,
      weight_lbs: true,
      status: true,
      source: { select: { name: true, street: true, city: true, state: true, zip: true } },
      transporter: { select: { name: true } },
      assigned_operator: { select: { name: true } },
    },
    orderBy: [{ arrived_at: 'asc' }, { id: 'asc' }],
  });

  const site = { code: ctx.siteCode, name: ctx.siteName };
  const rows = (loads as LoadRowInput[]).map((l) => buildSvdpRow(l, site));
  const csv = toCsv(rows, loadColumnsForSvdp());

  const filename = `dr3-svdp-internal-${ctx.siteCode}-${parsed.data.month}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
