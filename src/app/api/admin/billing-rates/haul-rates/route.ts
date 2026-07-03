// ADR-0040 D2/D5 — account_haul_rates CRUD (list + create).
//
// GET  /api/admin/billing-rates/haul-rates[?source=<id>]  — manager+ read
// POST /api/admin/billing-rates/haul-rates                — rate-manager write

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRateRead, requireRateManager } from '@/lib/auth-helpers';
import { listHaulRates, createHaulRate } from '@/lib/billing-rates/admin-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const createSchema = z.object({
  source_id: z.string().min(1),
  rate_cents: z.number().int().positive(),
  effective_from: isoDate,
  effective_to: isoDate.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

function ipOf(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

export async function GET(req: Request) {
  try {
    await requireRateRead();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const source = new URL(req.url).searchParams.get('source') ?? undefined;
  return NextResponse.json({ rates: await listHaulRates(source) });
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireRateManager();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload', details: parsed.error.flatten() }, { status: 422 });
  }
  const result = await createHaulRate(
    {
      source_id: parsed.data.source_id,
      rate_cents: parsed.data.rate_cents,
      effective_from: parsed.data.effective_from,
      effective_to: parsed.data.effective_to ?? null,
      note: parsed.data.note ?? null,
    },
    { actorUserId: ctx.userId, ip: ipOf(req), userAgent: req.headers.get('user-agent') ?? null },
  );
  if (!result.ok) {
    const status = result.reason === 'source_not_found' ? 422 : result.reason === 'invalid_amount' ? 422 : 404;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({ rate: result.rate }, { status: 201 });
}
