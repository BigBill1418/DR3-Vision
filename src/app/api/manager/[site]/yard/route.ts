// handoff §1.8 — manager Yard view API (GET = read model, POST = add trailer).
//
// Site-reach only (`requireManagerForSite` — hard rule #2: manager-on-own-site, an
// all-sites manager, or admin; operator → 403). The ADR-0047 UI-surface pilot gate
// (`yard_list`) is enforced at the PAGE, not here — mirrors the equipment surface,
// where the API is the plain site guard and the page does the visibility gate.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { createTrailer, getYardView } from '@/lib/yard/service';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['on_yard', 'at_account', 'in_service'] as const;

const Create = z.object({
  label: z.string().trim().min(1).max(120),
  locationNote: z.string().max(500).nullable().optional(),
  status: z.enum(STATUSES).optional(),
});

/** Map a caught error to a JSON response + a diagnosable log line (tagged [yard]). */
function yardErrorResponse(
  e: unknown,
  ctx: { site: string; op: string; id?: string; requestId?: string | null },
): NextResponse {
  const base = { site: ctx.site, op: ctx.op, id: ctx.id, request_id: ctx.requestId ?? undefined };
  if (e instanceof Response) {
    log.warn({ ...base, status: e.status }, '[yard] request rejected');
    return NextResponse.json({ error: e.statusText || 'error' }, { status: e.status });
  }
  if (e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number') {
    const se = e as { status: number; message: string };
    log.warn({ ...base, status: se.status, reason: se.message }, '[yard] request rejected');
    return NextResponse.json({ error: se.message }, { status: se.status });
  }
  log.error({ ...base, err: e }, '[yard] unexpected error (500)');
  throw e;
}

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const view = await getYardView(ctx.siteId);
    return NextResponse.json(view);
  } catch (e) {
    return yardErrorResponse(e, { site, op: 'yard.list', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const trailer = await createTrailer({
      siteId: ctx.siteId,
      actorUserId: ctx.userId,
      ...parsed.data,
    });
    return NextResponse.json({ trailer }, { status: 201 });
  } catch (e) {
    return yardErrorResponse(e, { site, op: 'yard.create', requestId: req.headers.get('x-request-id') });
  }
}
