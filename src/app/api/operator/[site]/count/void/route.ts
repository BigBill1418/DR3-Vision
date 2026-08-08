// ADR-0084 — iPad FLOOR same-day count VOID.
//
// A transport, like its sibling `../route.ts`: every gate that decides anything
// lives in `voidSnapshot` (src/lib/inventory/void-count.ts), so there is one copy
// of the money path with two callers rather than two copies that drift.
//
// Operator-PIN gated + ADR-0065 rollout-gated on the SAME per-surface
// `ipad_count` flag as the count itself. Deliberately the same flag: a site whose
// count screen is dark must not have a live withdrawal endpoint behind it, and
// turning the count on has always meant turning its whole workflow on.
//
// NOT reachable from the offline queue. `operator.count.void` is absent from
// `FLOOR_SCOPES`, so `/api/queue/replay` answers 400 `unknown_scope` for it —
// see the "Why this is online-only" note in void-count.ts (ADR-0084 D5).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireActivatedOperator,
  loadsErrorResponse,
  readIdempotencyKey,
} from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { SnapshotVoidAmendmentRequiredError, voidSnapshot } from '@/lib/inventory/void-count';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The snapshot id is the ONLY thing the body carries. Site and actor are
// re-derived from the session — the two fields a stale screen or a hostile
// client would most want to control (floor-writes.ts rule 1).
const Body = z.object({ snapshotId: z.string().min(1).max(64) });

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_COUNT);
    const idempotencyKey = readIdempotencyKey(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });

    const result = await voidSnapshot({
      snapshotId: parsed.data.snapshotId,
      actorUserId: ctx.userId,
      siteId: ctx.siteId,
      idempotencyKey,
    });

    return NextResponse.json(
      {
        voided: true,
        snapshotId: result.snapshotId,
        voidedAt: result.voidedAt,
        alreadyVoided: result.alreadyVoided,
        physicalTotal: result.physicalTotal,
      },
      { status: 200 },
    );
  } catch (e) {
    // ADR-0084 D4 — the prior-day refusal. 409, `requires_amendment`-SHAPED, and
    // NOT the bonus amendment workflow: nothing is submitted, no approver is
    // resolved, no `bonus_amendment_requests` row is written. The shape is
    // borrowed so a client that already renders "this needs the office" renders
    // this too. Do not wire this branch into the bonus workflow — the reasoning
    // is in the error class's own doc comment.
    if (e instanceof SnapshotVoidAmendmentRequiredError) {
      return NextResponse.json(e.toBody(), { status: e.status });
    }
    return loadsErrorResponse(e, {
      site,
      op: 'operator.count.void',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
