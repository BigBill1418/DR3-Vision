// ADR-0085 — iPad walk-up drop-off capture (Public / Incentive).
//
// JT: *"a tile or static button on the iPad; hitting it prompts Public Drop Off
// or Incentive Drop, then asks for total units and a photo; contributes to daily
// inbound and inventory."*
//
// Operator-PIN gated + ADR-0047 rollout-gated on its OWN `ipad_dropoff` surface
// via `requireActivatedOperator`. The rollout flag hides the PAGE; THIS is the
// boundary — a bookmarked URL, a stale bundle, or a hand-rolled POST is refused
// here regardless of what any UI chose to render.
//
// The write itself lives in `dropoffCreate` (`@/lib/operator/floor-writes`),
// shared verbatim with `/api/queue/replay`, so "a replayed drop-off is subject to
// exactly the same gates as a live one" is a structural fact rather than a claim
// two files have to keep agreeing about.
//
// NO MONEY, NO PII. Neither the request schema nor `createFloorDropoff` has a
// field for a name, a payee, an amount or a check — the Incentive label's $3/unit
// is tracked elsewhere, deliberately (Bill, 2026-08-07). Below the application,
// `consumer_dropoffs_floor_no_money_or_pii` refuses any row that carries them.

import { NextResponse } from 'next/server';
import {
  requireActivatedOperator,
  loadsErrorResponse,
  assertCurrentPacificDay,
  readIdempotencyKey,
} from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { DropoffCreate, dropoffCreate } from '@/lib/operator/floor-writes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_DROPOFF);
    const idempotencyKey = readIdempotencyKey(req);
    const parsed = DropoffCreate.safeParse(await req.json());
    // 422 rather than 400: this is where a photo-less submit dies. The client
    // disables the button without one and the schema requires the key, so a
    // request arriving here without it is a stale bundle or a hand-rolled call —
    // both of which must be refused, neither of which should be able to write a
    // drop-off with no evidence behind it.
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    // ADR-0065 — current Pacific day only. Not the device clock and not UTC: a
    // drop-off filed against the wrong day moves the inventory ledger on two
    // days at once, and at 5pm Pacific the two calendars disagree.
    assertCurrentPacificDay(parsed.data.dropoffDate);
    const result = await dropoffCreate({ ctx, payload: parsed.data, idempotencyKey });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'operator.dropoff.create',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
