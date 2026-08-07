// ADR-0060 F-3 — iPad FLOOR physical on-hand count API.
//
// A floor operator enters the physical on-hand count; it becomes the new inventory
// anchor via the SAME `reconcilePhysicalCount` money path the manager desktop uses
// (/api/manager/[site]/snapshots) — no new inventory math, the floor is just a new
// caller, actor = operator.
//
// Operator-PIN gated + ADR-0047 rollout-gated via `requireActivatedOperator` on the
// per-surface `ipad_count` gate (ADR-0065), not the shared `loads_inventory` master gate.
//
// ADR-0078 — this route is now a TRANSPORT. The guardrail, the idempotency claim
// and the reconcile all live in `countCreate` (src/lib/operator/floor-writes.ts),
// which the offline-queue replay endpoint dispatches through as well. Two copies
// of a money path drift; one copy with two callers cannot.
//
// ADR-0078 D10 — the count now carries the DAY it was taken. This route used to
// take no date at all and derive the day from `new Date()` at write time, which
// is right for a live submit and silently wrong for a replayed one: an entry
// queued Tuesday evening and replayed Wednesday morning would have anchored
// Wednesday's inventory with Tuesday's count. `assertCurrentPacificDay` refuses
// that instead — the operator resolves it, we never guess.

import { NextResponse } from 'next/server';
import { PoolSplitMismatchError } from '@/lib/inventory/running-balance';
import {
  requireActivatedOperator,
  loadsErrorResponse,
  assertCurrentPacificDay,
  readIdempotencyKey,
} from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { CountCreate, countCreate } from '@/lib/operator/floor-writes';
import { pacificDayISO } from '@/lib/time';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_COUNT);
    const idempotencyKey = readIdempotencyKey(req);
    const parsed = CountCreate.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });

    // Old-shell compatibility. The floor iPads are kiosks whose service worker
    // does not `skipWaiting`, so a device keeps serving the PREVIOUS bundle
    // until an operator accepts the update prompt — and that bundle sends no
    // `countDate`. Defaulting it here is behaviour-identical to the pre-ADR-0078
    // route, which derived the same day from the same clock; refusing instead
    // would 422 every count at both sites for as long as one device stayed on
    // the old shell.
    //
    // Safe ONLY on this path, because a live submit genuinely is happening now.
    // The replay endpoint refuses a day-addressed entry with no day rather than
    // defaulting, so a queued entry can never pick up "today" this way.
    const countDate = parsed.data.countDate ?? pacificDayISO(new Date());
    if (parsed.data.countDate === undefined) {
      log.warn(
        { site, op: 'count.legacy_shell_no_date', assumed_day: countDate },
        '[floor] count submitted without countDate — device is on a pre-ADR-0078 bundle',
      );
    }

    // ADR-0065 / ADR-0078 D10 — current Pacific day only, pinned BEFORE the
    // write. Pacific, not server-local: the container runs UTC, so a local
    // comparison would start refusing the operator's real day at 5 PM.
    assertCurrentPacificDay(countDate);

    const result = await countCreate({
      ctx,
      payload: { ...parsed.data, countDate },
      idempotencyKey,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    // A measured split that doesn't sum → 422 with the plain-English reason.
    if (e instanceof PoolSplitMismatchError) {
      return NextResponse.json({ error: 'pool_mismatch', message: e.message }, { status: 422 });
    }
    return loadsErrorResponse(e, {
      site,
      op: 'operator.count.create',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
