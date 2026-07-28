// ADR-0060 F-3 — iPad FLOOR physical on-hand count API.
//
// A floor operator enters the physical on-hand count; it becomes the new inventory
// anchor via the SAME `reconcilePhysicalCount` money path the manager desktop uses
// (/api/manager/[site]/snapshots) — no new inventory math, the floor is just a new
// caller, actor = operator. Highest value on Eugene, which has no physical anchor yet:
// this establishes its first one. `reconcilePhysicalCount` records the reconciled_delta
// (physical − computed) and never clobbers an existing snapshot (it appends a new one).
//
// Operator-PIN gated + ADR-0047 rollout-gated via `requireActivatedOperator` on the
// per-surface `ipad_count` gate (ADR-0065), not the shared `loads_inventory` master gate.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { reconcilePhysicalCount, PoolSplitMismatchError } from '@/lib/inventory/running-balance';
import { requireActivatedOperator, loadsErrorResponse } from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { pacificMidnightInstantOfDayISO, pacificDayISO } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Create = z.object({
  // Jurisdiction-appropriate subset (CA indoor, OR total); blanks are null. Outdoor is
  // not tracked — ADR-0037 addendum.
  unitsIndoor: z.number().int().nonnegative().nullable().optional(),
  unitsTotal: z.number().int().nonnegative().nullable().optional(),
  unitsInProcessing: z.number().int().nonnegative().default(0),
  programUnits: z.number().int().nonnegative().nullable().optional(),
  nonProgramUnits: z.number().int().nonnegative().nullable().optional(),
  poolAttribution: z.enum(['measured', 'legacy']).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_COUNT);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const result = await reconcilePhysicalCount({
      siteId: ctx.siteId,
      // D-3: the count anchors at Pacific-midnight of TODAY (the floor counts the current
      // day's closing position), never UTC-midnight — see anchorFlowBounds.
      countedAt: pacificMidnightInstantOfDayISO(pacificDayISO(new Date())),
      physical: {
        units_indoor: d.unitsIndoor ?? null,
        units_total: d.unitsTotal ?? null,
        units_in_processing: d.unitsInProcessing,
      },
      programUnits: d.programUnits ?? null,
      nonProgramUnits: d.nonProgramUnits ?? null,
      poolAttribution: d.poolAttribution ?? 'measured',
      actorUserId: ctx.userId,
    });
    return NextResponse.json(result, { status: 201 });
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
