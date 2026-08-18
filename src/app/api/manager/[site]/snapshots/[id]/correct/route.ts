// ADR-0105 — manager CORRECTION of a physical count (today or yesterday, Pacific).
//
// A transport, exactly like the ADR-0084 void route next door: every gate that
// decides anything lives in `correctPhysicalCount`
// (src/lib/inventory/correct-count.ts), so there is one copy of the money path
// with one caller rather than a route that re-implements half of it and drifts.
//
// Gated on `requireActivatedManager`, which is `requireManagerForSite` (401
// anonymous / 403 operator / 404 unknown site / 403 manager off-site, hard rule
// #2) plus the ADR-0037 D7 activation gate that every sibling manager route under
// `/api/manager/[site]/**` carries. Using the activated wrapper rather than the
// bare guard is strictly stronger and keeps this surface dark on a site whose
// loads/inventory module has not been turned on — the count screen it corrects is
// behind the same gate.
//
// An OPERATOR reaching this endpoint is refused 403 by the role check inside that
// guard. Operators keep exactly what ADR-0084 Amendment 1 gave them and nothing
// more: a same-day, site-scoped SELF-VOID at `/api/operator/[site]/count/void`.
// This route grants no new floor capability and removes none.
//
// NOT reachable from the offline queue: `manager.count.correct` is absent from
// `FLOOR_SCOPES`, so `/api/queue/replay` answers 400 `unknown_scope`. See the
// scope's doc comment for why a replayed correction is worse than a replayed void.
//
// There is NO approval gate on this write — Bill's decision, recorded in ADR-0105.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireActivatedManager,
  loadsErrorResponse,
  readIdempotencyKey,
} from '@/lib/loads/route-helpers';
import { PoolSplitMismatchError } from '@/lib/inventory/running-balance';
import {
  correctPhysicalCount,
  listWindowCountsAtSite,
  CountCorrectionOutsideWindowError,
  CountCorrectionConflictError,
} from '@/lib/inventory/correct-count';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The corrected VALUE and nothing else. The snapshot id comes from the path, and
// the site and actor are re-derived from the session — the three fields a stale
// screen or a hostile client would most want to control.
const Body = z.object({
  units_indoor: z.number().int().nullable().optional(),
  units_total: z.number().int().nullable().optional(),
  units_in_processing: z.number().int().nonnegative().default(0),
  program_units: z.number().int().nonnegative().nullable().optional(),
  non_program_units: z.number().int().nonnegative().nullable().optional(),
  pool_attribution: z.enum(['measured', 'legacy']).optional(),
});

/**
 * The two-day window's counts — live AND superseded, each carrying `correctable`
 * and its chain links. Superseded rows ride along deliberately: the screen has to
 * show what a corrected count was corrected FROM, or the soft-void discipline is
 * invisible to the only people who can act on it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    return NextResponse.json({ rows: await listWindowCountsAtSite(ctx.siteId) });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'manager.count.correct.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const idempotencyKey = readIdempotencyKey(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;

    const result = await correctPhysicalCount({
      snapshotId: id,
      actorUserId: ctx.userId,
      siteId: ctx.siteId,
      corrected: {
        units_indoor: d.units_indoor ?? null,
        units_total: d.units_total ?? null,
        units_in_processing: d.units_in_processing,
      },
      programUnits: d.program_units ?? null,
      nonProgramUnits: d.non_program_units ?? null,
      poolAttribution: d.pool_attribution ?? 'measured',
      idempotencyKey,
    });

    return NextResponse.json({ corrected: true, ...result }, { status: 200 });
  } catch (e) {
    // The two-day window refusal. 409, with the full body — the message names the
    // counted day, today, and the earliest day still correctable, so the manager
    // learns the rule from the refusal instead of from a token.
    if (e instanceof CountCorrectionOutsideWindowError) {
      return NextResponse.json(e.toBody(), { status: e.status });
    }
    // Lost the race to a concurrent correction. An error rather than a no-op
    // success, because the caller's number is NOT on the record — see the error
    // class's doc comment for why this diverges from ADR-0084's racing voids.
    if (e instanceof CountCorrectionConflictError) {
      return NextResponse.json(
        {
          error: e.error,
          snapshotId: e.snapshotId,
          message:
            'This count was corrected by someone else a moment ago. Reload the list and ' +
            'apply your correction to the current value.',
        },
        { status: e.status },
      );
    }
    // A measured split that does not sum to the corrected total — the same 422 the
    // sibling snapshots route returns, from the same error class.
    if (e instanceof PoolSplitMismatchError) {
      return NextResponse.json({ error: 'pool_mismatch', message: e.message }, { status: 422 });
    }
    return loadsErrorResponse(e, {
      site,
      id,
      op: 'manager.count.correct',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
