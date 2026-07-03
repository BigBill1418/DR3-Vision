// ADR-0040 D4/D5 — fuel_prices list + manual entry (audited overwrite).
//
// GET  /api/admin/billing-rates/fuel-prices[?limit=n]  — manager+ read
// POST /api/admin/billing-rates/fuel-prices            — rate-manager manual entry
//   body: { week_of: YYYY-MM-DD (any day in the week), usd_per_gal, note? }
//   Creates/overwrites the week's row with source=manual (manual wins; audited).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRateRead, requireRateManager } from '@/lib/auth-helpers';
import { listFuelPrices, upsertManualFuelPrice } from '@/lib/billing-rates/admin-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  week_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  usd_per_gal: z.number().positive().lt(100),
  note: z.string().max(500).nullable().optional(),
});

export async function GET(req: Request) {
  try {
    await requireRateRead();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const limitParam = Number(new URL(req.url).searchParams.get('limit') ?? '26');
  const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 260 ? limitParam : 26;
  return NextResponse.json({ prices: await listFuelPrices(limit) });
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
  const result = await upsertManualFuelPrice(
    { week_of: parsed.data.week_of, usd_per_gal: parsed.data.usd_per_gal, note: parsed.data.note ?? null },
    {
      actorUserId: ctx.userId,
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: req.headers.get('user-agent') ?? null,
    },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 422 });
  }
  return NextResponse.json({ price: result.price }, { status: 201 });
}
