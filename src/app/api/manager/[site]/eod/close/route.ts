// ADR-0125 — close the day (clean or with a named exception), and reopen it with
// an audited reason.
//
// POST   -> close
// DELETE -> reopen (the day stops being closed; the row and its history remain)
//
// Reopen is DELETE rather than a second POST because it is the inverse of the
// close, not another close: a POST that sometimes closed and sometimes undid a
// close would make a retried request ambiguous.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { loadsErrorResponse, requireActivatedManagerSurface } from '@/lib/loads/route-helpers';
import { closeEodDay, reopenEodDay, MIN_EOD_REASON_CHARS } from '@/lib/eod/day-close';
import { resolveEodDayKey } from '@/lib/eod/day-param';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Close = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outcome: z.enum(['clean', 'exception']),
  // Validated for CONTENT in the service (min length, and refused on a clean
  // close) so the rule lives with the CHECK constraint that backs it, not in two
  // places that can drift.
  exceptionNote: z.string().max(2000).optional(),
});

const Reopen = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(MIN_EOD_REASON_CHARS).max(2000),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.EOD_REVIEW);
    const parsed = Close.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const row = await closeEodDay({
      siteId: ctx.siteId,
      closeDate: resolveEodDayKey(parsed.data.day),
      outcome: parsed.data.outcome,
      exceptionNote: parsed.data.exceptionNote ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'manager.eod.close',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.EOD_REVIEW);
    const parsed = Reopen.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const row = await reopenEodDay({
      siteId: ctx.siteId,
      closeDate: resolveEodDayKey(parsed.data.day),
      reason: parsed.data.reason,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'manager.eod.reopen',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
