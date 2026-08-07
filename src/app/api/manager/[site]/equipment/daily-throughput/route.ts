// ADR-0079 D2/D4 — the manager's DAILY machine capture API (list + upsert).
//
// Manager-scoped to the caller's own site (`requireManagerForSite` — the same gate
// the sibling equipment-event routes use); an operator gets 403. Site-scoped reads
// only (CLAUDE.md hard rule #2).
//
//   GET  → the machine's recorded days, newest first
//   POST → record or edit TODAY (Pacific). A prior day is REFUSED with
//          409 `requires_amendment` (ADR-0079 D4), never silently accepted.
//
// There is no PATCH: the (equipment, day) partial unique makes a second same-day
// POST an EDIT of the same row rather than a duplicate, so one verb covers both.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import {
  DailyThroughputAmendmentRequiredError,
  MAX_RUN_HOURS,
  MAX_UNITS_PROCESSED,
  listDailyThroughput,
  upsertDailyThroughput,
} from '@/lib/equipment/daily-throughput';
import { equipmentErrorResponse, clampLimit } from '@/lib/equipment/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The bounds are asserted AGAIN in the service and AGAIN as DB CHECKs. Three
// layers on purpose: zod guards the wire, the service guards every caller
// (including future ones that never touch HTTP), and the CHECK guards the table
// against a write path nobody has written yet.
const Upsert = z.object({
  throughputDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unitsProcessed: z.number().int().nonnegative().max(MAX_UNITS_PROCESSED),
  runHours: z.number().positive().max(MAX_RUN_HOURS),
  notes: z.string().max(2000).nullable().optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 60);
    const includeVoided = new URL(req.url).searchParams.get('includeVoided') === '1';
    const rows = await listDailyThroughput(ctx.siteId, { limit, includeVoided });
    return NextResponse.json({ rows });
  } catch (e) {
    return equipmentErrorResponse(e, {
      site,
      op: 'equipment.dailyThroughput.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Upsert.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid_input', issues: parsed.error.issues },
        { status: 422 },
      );
    }
    const d = parsed.data;
    const row = await upsertDailyThroughput({
      siteId: ctx.siteId,
      throughputDate: new Date(`${d.throughputDate}T00:00:00Z`),
      unitsProcessed: d.unitsProcessed,
      runHours: d.runHours,
      notes: d.notes ?? null,
      // ADR-0036/0077 actor discipline — the REAL signed-in manager, never a
      // system label on a human's entry and never a borrowed id.
      actor: {
        actorUserId: ctx.userId,
        ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: req.headers.get('user-agent'),
      },
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    // ADR-0079 D4 — the prior-day refusal carries CONTEXT (what is on record vs
    // what was typed), which the generic mapper would flatten to a bare
    // `{ error }`. Handled here so the UI can tell the manager what it is
    // refusing to change and where to take it.
    if (e instanceof DailyThroughputAmendmentRequiredError) {
      return NextResponse.json(e.toBody(), { status: e.status });
    }
    return equipmentErrorResponse(e, {
      site,
      op: 'equipment.dailyThroughput.upsert',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
