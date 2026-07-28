// ADR-0060 F-2 — iPad FLOOR inbound-confirmation API (list + confirm/correct/enter).
//
// Operator-PIN gated + ADR-0047 rollout-gated via `requireActivatedOperator`, the floor
// analogue of the manager `requireActivatedManager`. ADR-0065: this write path is gated on
// its OWN `ipad_inbound` surface, not the shared `loads_inventory` master gate, used by /api/manager/[site]/bulk-inbound
// (the desktop path this mirrors). Every write re-derives operator + site from the session
// server-side — a client-supplied siteId/userId is never trusted.
//
//   GET  — recent aggregate inbound days (provisional / floor-confirmed / office) + a
//          per-day hasPerLoadCapture flag; today pinned so Eugene / a missed day can be
//          ENTERED from scratch.
//   POST — confirm / correct / enter one day's counts via `confirmFloorInboundDay`, which
//          retires the day's `mymrc_haul` provisional and installs one `ipad_floor`
//          aggregate in one audited transaction (the ADR-0059 delete-then-write contract).
//          Money-safety: refuses a day with per-load dock captures (409 per_load_exists)
//          and a day owned by the office (409 office_owned); split mismatch → 422.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { confirmFloorInboundDay, listFloorInboundDays } from '@/lib/loads/floor-inbound';
import {
  requireActivatedOperator,
  loadsErrorResponse,
  assertCurrentPacificDay,
} from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ADR-0065 — the floor iPad shows exactly one day: today. */
const FLOOR_DAY_WINDOW = 1;

const Confirm = z.object({
  inboundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalUnits: z.number().int().positive(),
  programUnits: z.number().int().nonnegative(),
  nonProgramUnits: z.number().int().nonnegative(),
  correctionNote: z.string().max(120).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_INBOUND);
    // ADR-0065 — current Pacific day only (no historical/future views on the iPad).
    const rows = await listFloorInboundDays(ctx.siteId, ctx.userId, FLOOR_DAY_WINDOW);
    return NextResponse.json({ rows });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'operator.inbound.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_INBOUND);
    const parsed = Confirm.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    // ADR-0065 — current Pacific day only; a hand-edited or replayed body
    // must not be able to confirm counts against another day.
    assertCurrentPacificDay(d.inboundDate);
    const row = await confirmFloorInboundDay({
      siteId: ctx.siteId,
      // D-3: key the day at Pacific-midnight; `${date}T00:00:00Z` round-trips to the same
      // YYYY-MM-DD day key `inboundArrivedAt` consumes (see bulk-inbound.ts).
      inboundDate: new Date(`${d.inboundDate}T00:00:00Z`),
      totalUnits: d.totalUnits,
      programUnits: d.programUnits,
      nonProgramUnits: d.nonProgramUnits,
      correctionNote: d.correctionNote ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    // FloorInboundConflictError (409 per_load_exists / office_owned) and RecordValidationError
    // (422 split mismatch) both carry a numeric `status`, so loadsErrorResponse surfaces
    // them as-is with the reason string.
    return loadsErrorResponse(e, {
      site,
      op: 'operator.inbound.confirm',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
