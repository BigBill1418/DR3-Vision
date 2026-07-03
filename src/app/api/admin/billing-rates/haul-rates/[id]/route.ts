// ADR-0040 D2/D5 — account_haul_rates update.
//
// PATCH /api/admin/billing-rates/haul-rates/[id]  — rate-manager write

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRateManager } from '@/lib/auth-helpers';
import { updateHaulRate, type HaulRateUpdate } from '@/lib/billing-rates/admin-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const updateSchema = z.object({
  rate_cents: z.number().int().positive().optional(),
  effective_from: isoDate.optional(),
  effective_to: isoDate.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: Params) {
  let ctx;
  try {
    ctx = await requireRateManager();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload', details: parsed.error.flatten() }, { status: 422 });
  }
  const input: HaulRateUpdate = {};
  if (parsed.data.rate_cents !== undefined) input.rate_cents = parsed.data.rate_cents;
  if (parsed.data.effective_from !== undefined) input.effective_from = parsed.data.effective_from;
  if (parsed.data.effective_to !== undefined) input.effective_to = parsed.data.effective_to;
  if (parsed.data.note !== undefined) input.note = parsed.data.note;

  const result = await updateHaulRate(id, input, {
    actorUserId: ctx.userId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 422 });
  }
  return NextResponse.json({ rate: result.rate });
}
