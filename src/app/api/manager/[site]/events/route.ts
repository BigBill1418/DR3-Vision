// ADR-0041 D3 — collection_events manager API (list + create). Site-scoped +
// D7 activation-gated (admin-only for now, mirrors the ADR-0037 loads surfaces).
// Wage cents left blank default from the B5 rules in the service; supplied wages
// are stored as entered.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createEvent, listEvents, type CreateEventArgs } from '@/lib/events/service';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cents = z.number().int().nonnegative().max(1_000_000_00);
const units = z.number().int().nonnegative().max(1_000_000);
const hours = z.number().nonnegative().max(999.99);

const Create = z.object({
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customer: z.string().min(1).max(200),
  county: z.string().max(120).optional(),
  slipNumber: z.string().max(120).optional(),
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
  retracId: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 100);
    return NextResponse.json({ rows: await listEvents(ctx.siteId, limit) });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'events.list',
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
    const eventArgs: CreateEventArgs = {
      siteId: ctx.siteId,
      eventDate: new Date(`${d.eventDate}T00:00:00Z`),
      customer: d.customer,
      county: d.county ?? null,
      slipNumber: d.slipNumber ?? null,
      units: d.units ?? null,
      freightCents: d.freightCents ?? null,
      driverHours: d.driverHours ?? null,
      driverWagesCents: d.driverWagesCents ?? null,
      laborHours: d.laborHours ?? null,
      laborWagesCents: d.laborWagesCents ?? null,
      mileage: d.mileage ?? null,
      mileageCents: d.mileageCents ?? null,
      perDiemCents: d.perDiemCents ?? null,
      miscCents: d.miscCents ?? null,
      retracId: d.retracId ?? null,
      notes: d.notes ?? null,
      actorUserId: ctx.userId,
    };
    const row = await createEvent(eventArgs);
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'events.create',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
