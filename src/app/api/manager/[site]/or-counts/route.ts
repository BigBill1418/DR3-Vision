// ADR-0041 D3 — Oregon collection-site counts manager API (list + create).
// Site-scoped + D7 activation-gated. The service refuses a non-OR site (typed
// JurisdictionNotAllowedError → 422). No invoice math here; the $2.25/unit rate
// stays in state_program_rules and the sibling invoice engine consumes at merge.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createOrCount, listOrCounts } from '@/lib/events/or-counts';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Create = z.object({
  billingMonth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  location: z.string().min(1).max(200),
  units: z.number().int().nonnegative().max(1_000_000),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 100);
    return NextResponse.json({ rows: await listOrCounts(ctx.siteId, limit) });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'or_counts.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await createOrCount({
      siteId: ctx.siteId,
      billingMonth: new Date(`${d.billingMonth}T00:00:00Z`),
      location: d.location,
      units: d.units,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'or_counts.create',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
