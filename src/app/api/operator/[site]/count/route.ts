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
import { prisma } from '@/lib/prisma';
import {
  classifyAnchorWrite,
  describeSwing,
  loadPriorAnchor,
  loadSwingThresholdPct,
} from '@/lib/inventory/anchor-guardrail';
import { createHold, eligibleApprovers } from '@/lib/inventory/anchor-holds';

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

    // ── ADR-0072 — the guardrail, enforced HERE ─────────────────────────────
    // Recomputed server-side from live state on every write. The client
    // classifies the same count only to decide what dialog to show; a request
    // that skips the dialog still meets this. If the UI and this disagree, this
    // wins — which is the difference between a control and a courtesy.
    const newTotal = (d.unitsTotal ?? d.unitsIndoor ?? 0) + d.unitsInProcessing;
    const [prior, thresholdPct] = await Promise.all([
      loadPriorAnchor(prisma, ctx.siteId),
      loadSwingThresholdPct(prisma, ctx.siteId),
    ]);
    const classification = classifyAnchorWrite({ prior, newTotal, thresholdPct });

    if (classification.requiresManagerApproval) {
      // Tier 2. NOT rejected and NOT written — held with its values intact so a
      // manager can release it, and so the operator's work is never lost to a
      // refusal. A 422 here means "a person must look at this", not "try again".
      const hold = await createHold(prisma, {
        siteId: ctx.siteId,
        createdBy: ctx.userId,
        input: {
          unitsIndoor: d.unitsIndoor ?? null,
          unitsTotal: d.unitsTotal ?? null,
          unitsInProcessing: d.unitsInProcessing,
          programUnits: d.programUnits ?? null,
          nonProgramUnits: d.nonProgramUnits ?? null,
          poolAttribution: d.poolAttribution ?? 'measured',
        },
        classification,
      });
      const approvers = await eligibleApprovers(prisma, ctx.siteId);
      return NextResponse.json(
        {
          error: 'manager_approval_required',
          holdId: hold.id,
          tier: 2,
          priorTotal: classification.prior?.total ?? null,
          newTotal: classification.newTotal,
          swingPct: classification.swingPct,
          thresholdPct: classification.thresholdPct,
          message: describeSwing(classification),
          approvers,
        },
        { status: 422 },
      );
    }

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
    return NextResponse.json(
      {
        ...result,
        tier: classification.tier,
        priorTotal: classification.prior?.total ?? null,
        swingPct: classification.swingPct,
        thresholdPct: classification.thresholdPct,
      },
      { status: 201 },
    );
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
