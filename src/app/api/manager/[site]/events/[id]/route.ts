// ADR-0041 D3 — collection_events edit-before-lock (PATCH). Site-scoped + gated.
// A nulled field clears the column; an omitted field is left unchanged.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateEvent } from '@/lib/events/service';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cents = z.number().int().nonnegative().max(1_000_000_00).nullable();
const units = z.number().int().nonnegative().max(1_000_000).nullable();
const hours = z.number().nonnegative().max(999.99).nullable();

const Patch = z.object({
  customer: z.string().min(1).max(200).optional(),
  county: z.string().max(120).nullable().optional(),
  slipNumber: z.string().max(120).nullable().optional(),
  units: units.optional(),
  freightCents: cents.optional(),
  driverHours: hours.optional(),
  driverWagesCents: cents.optional(),
  laborHours: hours.optional(),
  laborWagesCents: cents.optional(),
  mileage: units.optional(),
  mileageCents: cents.optional(),
  perDiemCents: cents.optional(),
  miscCents: cents.optional(),
  retracId: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
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
    const row = await updateEvent({
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
      op: 'events.update',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
