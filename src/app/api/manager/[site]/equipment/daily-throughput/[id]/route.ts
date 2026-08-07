// ADR-0079 D2 — soft-void a daily throughput entry.
//
//   DELETE → SOFT-void (sets voided_at; NO hard delete — hard rule #6). The row is
//            retained and excluded from every series and the tile; the void is
//            itself audited.
//
// Because the (equipment, day) unique index is PARTIAL on `voided_at IS NULL`, a
// voided row releases its day: the day reads "not recorded" again and can be
// re-entered. An unconditional unique would have made a mistaken entry permanent.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { voidDailyThroughput } from '@/lib/equipment/daily-throughput';
import { equipmentErrorResponse } from '@/lib/equipment/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const row = await voidDailyThroughput({
      id,
      siteId: ctx.siteId,
      actor: {
        actorUserId: ctx.userId,
        ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: req.headers.get('user-agent'),
      },
    });
    return NextResponse.json({ row });
  } catch (e) {
    return equipmentErrorResponse(e, {
      site,
      id,
      op: 'equipment.dailyThroughput.void',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
