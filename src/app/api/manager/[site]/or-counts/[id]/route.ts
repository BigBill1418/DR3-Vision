// ADR-0041 D3 — Oregon collection-site counts edit-before-lock (PATCH).
// Site-scoped + gated.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateOrCount } from '@/lib/events/or-counts';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Patch = z.object({
  location: z.string().min(1).max(200).optional(),
  units: z.number().int().nonnegative().max(1_000_000).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Patch.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const row = await updateOrCount({
      id,
      siteId: ctx.siteId,
      actorUserId: ctx.userId,
      ...parsed.data,
    });
    return NextResponse.json({ row });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      id,
      op: 'or_counts.update',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
