// ADR-0125 — the EOD review read. One GET returns the whole screen: the day's
// sections, its gap flags, the close state, the banner-aware on-hand figure, the
// anchor inventory check and the month-to-date rollup.
//
// The page server-renders the same call for first paint; this route exists so the
// client can refresh after a gap-fill write without a full navigation. ONE
// function, two callers — the `count-corrections` pattern.

import { NextResponse } from 'next/server';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { loadsErrorResponse, requireActivatedManagerSurface } from '@/lib/loads/route-helpers';
import { getEodDayReview } from '@/lib/eod/day-review';
import { resolveEodDayKey } from '@/lib/eod/day-param';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.EOD_REVIEW);
    const dayKey = resolveEodDayKey(new URL(req.url).searchParams.get('day'));
    const review = await getEodDayReview({
      siteId: ctx.siteId,
      siteCode: ctx.siteCode,
      siteName: ctx.siteName,
      dayKey,
    });
    return NextResponse.json({ review });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'manager.eod.review',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
