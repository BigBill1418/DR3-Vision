// ADR-0125 — the EOD inbound gap-fill line, and the freight-flag correction.
//
// POST  -> add one missing inbound haul for the day, with the workbook's
//          identifiers (BOL/Check #, DR3 #, Haul #, Slip #) and its freight flag.
// PATCH -> flip `transport_charged` on an existing inbound row.
//
// The DR3 number is a field the manager TYPES. Nothing here touches
// `document_sequences`: Vision's counter reads 5000 while the sheet is at 4,755
// and climbing, so automatic issuance would collide around late October, and
// whether to reseed or to cut over on a named date is Bill's open decision.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { loadsErrorResponse, requireActivatedManagerSurface } from '@/lib/loads/route-helpers';
import { addEodInboundLine, setInboundTransportCharged } from '@/lib/eod/inbound-line';
import { resolveEodDayKey } from '@/lib/eod/day-param';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AddLine = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalUnits: z.number().int().positive(),
  programUnits: z.number().int().nonnegative(),
  nonProgramUnits: z.number().int().nonnegative(),
  weightLbs: z.number().int().nonnegative().max(100_000).nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
  bolNumber: z.string().max(120).optional(),
  dr3Number: z.string().max(120).optional(),
  haulNumber: z.string().max(120).optional(),
  slipNumber: z.string().max(120).optional(),
  transportCharged: z.boolean().optional(),
});

const SetFreight = z.object({
  loadId: z.string().uuid(),
  transportCharged: z.boolean(),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.EOD_REVIEW);
    const parsed = AddLine.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await addEodInboundLine({
      siteId: ctx.siteId,
      dayKey: resolveEodDayKey(d.day),
      totalUnits: d.totalUnits,
      programUnits: d.programUnits,
      nonProgramUnits: d.nonProgramUnits,
      weightLbs: d.weightLbs ?? null,
      sourceId: d.sourceId ?? null,
      bolNumber: d.bolNumber ?? null,
      dr3Number: d.dr3Number ?? null,
      haulNumber: d.haulNumber ?? null,
      slipNumber: d.slipNumber ?? null,
      transportCharged: d.transportCharged,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'manager.eod.inbound.add',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.EOD_REVIEW);
    const parsed = SetFreight.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    await setInboundTransportCharged({
      siteId: ctx.siteId,
      loadId: parsed.data.loadId,
      transportCharged: parsed.data.transportCharged,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'manager.eod.inbound.freight',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
