// ADR-0037 D3 — consumer_dropoffs edit-before-lock (PATCH). Site-scoped + gated.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateDropoff } from '@/lib/dropoffs/service';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Patch = z.object({
  units: z.number().int().positive().optional(),
  kind: z.enum(['incentive', 'unpaid', 'illegal']).optional(),
  consumerName: z.string().max(200).nullable().optional(),
  slipNumber: z.string().max(120).nullable().optional(),
  checkNumber: z.string().max(120).nullable().optional(),
  retracId: z.string().max(120).nullable().optional(),
  incentiveAmountCents: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
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
    const row = await updateDropoff({
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
      op: 'dropoffs.update',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
