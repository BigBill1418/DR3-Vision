// ADR-0040 D1/D5 — transport_rate_tiers CRUD.
//
// GET  /api/admin/billing-rates/tiers[?jurisdiction=CA|OR]  — manager+ read
// POST /api/admin/billing-rates/tiers                       — rate-manager write
//   body: { jurisdiction, effective_from, effective_to?, note?, tiers: [{min_miles,max_miles,rate_cents}] }
//   Saves the WHOLE effective set (validated contiguous-from-0, non-overlapping) —
//   422 with the offending rows when invalid.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRateRead, requireRateManager } from '@/lib/auth-helpers';
import { listTiers, saveTierSet, type FreightJurisdiction } from '@/lib/billing-rates/admin-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const saveSchema = z.object({
  jurisdiction: z.enum(['CA', 'OR']),
  effective_from: isoDate,
  effective_to: isoDate.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  tiers: z
    .array(
      z.object({
        min_miles: z.number().int().min(0),
        max_miles: z.number().int().min(0),
        rate_cents: z.number().int(),
      }),
    )
    .min(1),
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
  const url = new URL(req.url);
  const j = url.searchParams.get('jurisdiction');
  const jurisdiction = j === 'CA' || j === 'OR' ? (j as FreightJurisdiction) : undefined;
  return NextResponse.json({ tiers: await listTiers(jurisdiction) });
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
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload', details: parsed.error.flatten() }, { status: 422 });
  }

  const result = await saveTierSet(
    {
      jurisdiction: parsed.data.jurisdiction,
      effective_from: parsed.data.effective_from,
      effective_to: parsed.data.effective_to ?? null,
      note: parsed.data.note ?? null,
      tiers: parsed.data.tiers,
    },
    { actorUserId: ctx.userId, ip: ipOf(req), userAgent: req.headers.get('user-agent') ?? null },
  );
  if (!result.ok) {
    return NextResponse.json({ error: 'tier set invalid', problems: result.problems }, { status: 422 });
  }
  return NextResponse.json({ tiers: result.tiers }, { status: 201 });
}
