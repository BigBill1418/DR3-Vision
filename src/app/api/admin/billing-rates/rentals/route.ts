// ADR-0040 D3/D5 — container_rental_sites CRUD (list + create).
//
// GET  /api/admin/billing-rates/rentals[?site=<id>]  — manager+ read
// POST /api/admin/billing-rates/rentals              — rate-manager write

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRateRead, requireRateManager } from '@/lib/auth-helpers';
import { listRentals, createRental } from '@/lib/billing-rates/admin-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const createSchema = z.object({
  site_id: z.string().min(1),
  location_name: z.string().min(1).max(200),
  source_id: z.string().min(1).nullable().optional(),
  trailer_count: z.number().int().min(0),
  trailer_size: z.string().max(40).nullable().optional(),
  monthly_rate_cents: z.number().int().positive(),
  active: z.boolean().optional(),
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
  const site = new URL(req.url).searchParams.get('site') ?? undefined;
  return NextResponse.json({ rentals: await listRentals(site) });
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
  const result = await createRental(
    {
      site_id: parsed.data.site_id,
      location_name: parsed.data.location_name,
      source_id: parsed.data.source_id ?? null,
      trailer_count: parsed.data.trailer_count,
      trailer_size: parsed.data.trailer_size ?? null,
      monthly_rate_cents: parsed.data.monthly_rate_cents,
      active: parsed.data.active ?? true,
      effective_from: parsed.data.effective_from,
      effective_to: parsed.data.effective_to ?? null,
      note: parsed.data.note ?? null,
    },
    { actorUserId: ctx.userId, ip: ipOf(req), userAgent: req.headers.get('user-agent') ?? null },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 422 });
  }
  return NextResponse.json({ rental: result.rental }, { status: 201 });
}
