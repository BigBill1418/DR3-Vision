// ADR-0040 D3/D5 — container_rental_sites update (incl. active toggle).
//
// PATCH /api/admin/billing-rates/rentals/[id]  — rate-manager write

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRateManager } from '@/lib/auth-helpers';
import { updateRental, type RentalUpdate } from '@/lib/billing-rates/admin-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const updateSchema = z.object({
  location_name: z.string().min(1).max(200).optional(),
  source_id: z.string().min(1).nullable().optional(),
  trailer_count: z.number().int().min(0).optional(),
  trailer_size: z.string().max(40).nullable().optional(),
  monthly_rate_cents: z.number().int().positive().optional(),
  active: z.boolean().optional(),
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
  const input: RentalUpdate = {};
  const d = parsed.data;
  if (d.location_name !== undefined) input.location_name = d.location_name;
  if (d.source_id !== undefined) input.source_id = d.source_id;
  if (d.trailer_count !== undefined) input.trailer_count = d.trailer_count;
  if (d.trailer_size !== undefined) input.trailer_size = d.trailer_size;
  if (d.monthly_rate_cents !== undefined) input.monthly_rate_cents = d.monthly_rate_cents;
  if (d.active !== undefined) input.active = d.active;
  if (d.effective_from !== undefined) input.effective_from = d.effective_from;
  if (d.effective_to !== undefined) input.effective_to = d.effective_to;
  if (d.note !== undefined) input.note = d.note;

  const result = await updateRental(id, input, {
    actorUserId: ctx.userId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 422 });
  }
  return NextResponse.json({ rental: result.rental });
}
