// handoff §1.8 — manager Yard view API (PATCH = edit a trailer). Site-reach guard
// (`requireManagerForSite`, hard rule #2); the UI-surface pilot gate lives on the
// page. Invalid body → 422, unknown/cross-site id → 404 (typed via the service).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { updateTrailer } from '@/lib/yard/service';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['on_yard', 'at_account', 'in_service'] as const;

const Patch = z.object({
  label: z.string().trim().min(1).max(120).optional(),
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

export async function PATCH(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Patch.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const trailer = await updateTrailer({
      id,
      siteId: ctx.siteId,
      actorUserId: ctx.userId,
      ...parsed.data,
    });
    return NextResponse.json({ trailer });
  } catch (e) {
    return yardErrorResponse(e, { site, id, op: 'yard.update', requestId: req.headers.get('x-request-id') });
  }
}
