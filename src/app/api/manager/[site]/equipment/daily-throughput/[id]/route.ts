// ADR-0079 D2 — soft-void a daily throughput entry.
//
//   DELETE → SOFT-void (sets voided_at; NO hard delete — hard rule #6). The row is
//            retained and excluded from every series and the tile; the void is
//            itself audited.
//
// ADR-0106 — this verb carries the SAME month bound as the write path, because
// it is the other way to change what a day says: a void makes the day read
// "not recorded" everywhere. Guarding only the write would have left last
// month's figure uncorrectable but erasable. A backdated void needs `?reason=`.
//
// Because the (equipment, day) unique index is PARTIAL on `voided_at IS NULL`, a
// voided row releases its day: the day reads "not recorded" again and can be
// re-entered. An unconditional unique would have made a mistaken entry permanent.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import {
  DailyThroughputAmendmentRequiredError,
  voidDailyThroughput,
} from '@/lib/equipment/daily-throughput';
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
    // ADR-0106 — the why for a backdated removal. A QUERY PARAM rather than a
    // body: a DELETE with a payload is stripped by enough intermediaries that
    // the reason would arrive missing and the void would 422 for a manager who
    // typed one. It is not a secret — it is written to the audit trail either way.
    const reason = new URL(req.url).searchParams.get('reason');
    const row = await voidDailyThroughput({
      id,
      siteId: ctx.siteId,
      reason,
      actor: {
        actorUserId: ctx.userId,
        ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: req.headers.get('user-agent'),
      },
    });
    return NextResponse.json({ row });
  } catch (e) {
    // Same 409 body as the write path, so one UI branch handles both verbs.
    if (e instanceof DailyThroughputAmendmentRequiredError) {
      return NextResponse.json(e.toBody(), { status: e.status });
    }
    return equipmentErrorResponse(e, {
      site,
      id,
      op: 'equipment.dailyThroughput.void',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
