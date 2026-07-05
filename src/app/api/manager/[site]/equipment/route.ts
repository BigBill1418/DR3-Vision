// ADR-0044 D1/D3 — equipment_events manager API (list + create) + derived
// throughput read. Manager-scoped (own site) + admin; operator → 403.
//
//   GET  ?view=events   → the event log (default)
//   GET  ?view=throughput&windowDays=N → the derived trend series (D2/D3)
//   POST                → create an event

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { createEquipmentEvent, listEquipmentEvents } from '@/lib/equipment/service';
import { computeEquipmentThroughput } from '@/lib/equipment/throughput';
import { equipmentErrorResponse, clampLimit } from '@/lib/equipment/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['downtime', 'maintenance', 'repair', 'cost', 'note'] as const;

const Create = z.object({
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(KINDS),
  equipmentCode: z.string().trim().min(1).max(60).optional(),
  hoursDown: z.number().nonnegative().max(999.99).nullable().optional(),
  costCents: z.number().int().nonnegative().nullable().optional(),
  vendor: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const url = new URL(req.url);
    if (url.searchParams.get('view') === 'throughput') {
      const windowDays = clampLimit(url.searchParams.get('windowDays'), 90, 400);
      const equipmentCode = url.searchParams.get('equipmentCode') ?? undefined;
      const throughput = await computeEquipmentThroughput(ctx.siteId, {
        windowDays,
        ...(equipmentCode ? { equipmentCode } : {}),
      });
      return NextResponse.json({ throughput });
    }
    const limit = clampLimit(url.searchParams.get('limit'), 100);
    const includeVoided = url.searchParams.get('includeVoided') === '1';
    const equipmentCode = url.searchParams.get('equipmentCode') ?? undefined;
    const rows = await listEquipmentEvents(ctx.siteId, {
      limit,
      includeVoided,
      ...(equipmentCode ? { equipmentCode } : {}),
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return equipmentErrorResponse(e, { site, op: 'equipment.list', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await createEquipmentEvent({
      siteId: ctx.siteId,
      eventDate: new Date(`${d.eventDate}T00:00:00Z`),
      kind: d.kind,
      equipmentCode: d.equipmentCode ?? null,
      hoursDown: d.hoursDown ?? null,
      costCents: d.costCents ?? null,
      vendor: d.vendor ?? null,
      notes: d.notes ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return equipmentErrorResponse(e, { site, op: 'equipment.create', requestId: req.headers.get('x-request-id') });
  }
}
