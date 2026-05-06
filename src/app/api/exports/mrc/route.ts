// Sprint-1 T-013 - MRC Monthly Invoice (Article 10.4) export.
//
// GET /api/exports/mrc?site=eugene|woodland&month=YYYY-MM
//
// Returns a CSV body matching the MyMRC reconciliation column shape
// (see src/lib/exports.ts). One row per InboundLoad for the given site
// in the given month, status in {submitted, verified,
// submitted_to_mymrc, processed}.
//
// Auth: manager (own site) + admin (any site). Operator role gets 403.

import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireManagerForSite } from '@/lib/auth-helpers';
import {
  buildMrcRow,
  loadColumnsForMrc,
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

  // CLAUDE.md hard-rule #2: every domain query scopes by site_id. The
  // requireManagerForSite guard above resolved site_id from the
  // requested site code; it is the only site_id this query touches.
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
  const rows = (loads as LoadRowInput[]).map((l) => buildMrcRow(l, site));
  const csv = toCsv(rows, loadColumnsForMrc());

  const filename = `dr3-mrc-invoice-${ctx.siteCode}-${parsed.data.month}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
