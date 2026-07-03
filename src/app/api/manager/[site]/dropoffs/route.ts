// ADR-0037 D3 — consumer_dropoffs manager API (list + create). Site-scoped +
// D7 activation-gated (admin-only for now). person_name is CIP PII — never routed
// to an export surface (Exhibit I / ADR-0010).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createDropoff, listDropoffs } from '@/lib/dropoffs/service';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['incentive', 'unpaid', 'illegal'] as const;

const Create = z.object({
  dropoffDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(KINDS),
  personName: z.string().min(1).max(200),
  units: z.number().int().positive(),
  slipNumber: z.string().max(120).optional(),
  checkNumber: z.string().max(120).optional(),
  retracId: z.string().max(120).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 100);
    return NextResponse.json({ rows: await listDropoffs(ctx.siteId, limit) });
  } catch (e) {
    return loadsErrorResponse(e, { site, op: 'dropoffs.list', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await createDropoff({
      siteId: ctx.siteId,
      dropoffDate: new Date(`${d.dropoffDate}T00:00:00Z`),
      kind: d.kind,
      personName: d.personName,
      units: d.units,
      slipNumber: d.slipNumber ?? null,
      checkNumber: d.checkNumber ?? null,
      retracId: d.retracId ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, { site, op: 'dropoffs.create', requestId: req.headers.get('x-request-id') });
  }
}
