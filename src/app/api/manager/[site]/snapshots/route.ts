// ADR-0037 D6 + §3 pool split (handoff §1.4) — manager physical-count API
// (list + record). Site-scoped + D7 activation-gated (admin-only for now). A POST
// records a `physical` snapshot as the new inventory anchor and reconciles it to the
// computed running balance; a `measured` count carries the program/non-program pool
// split, validated to sum to the physical total (a wrong split silently mis-bills MRC).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { reconcilePhysicalCount, PoolSplitMismatchError } from '@/lib/inventory/running-balance';
import {
  classifyAnchorWrite,
  describeSwing,
  loadPriorAnchor,
  loadSwingThresholdPct,
} from '@/lib/inventory/anchor-guardrail';
import { createHold, eligibleApprovers } from '@/lib/inventory/anchor-holds';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';
import { pacificMidnightInstantOfDayISO } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Create = z.object({
  countedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Jurisdiction-appropriate subset (CA indoor, OR total); blanks are null.
  // Outdoor is not tracked — ADR-0037 addendum (2026-07-22).
  units_indoor: z.number().int().nullable().optional(),
  units_total: z.number().int().nullable().optional(),
  units_in_processing: z.number().int().nonnegative().default(0),
  program_units: z.number().int().nonnegative().optional(),
  non_program_units: z.number().int().nonnegative().optional(),
  pool_attribution: z.enum(['measured', 'legacy']).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 50);
    // ADR-0084 — DELIBERATELY UNFILTERED, and allowlisted as such in
    // `snapshot-void-readers.guard.test.ts`.
    //
    // This is a HISTORY, not an anchor selector. Nothing is computed from what it
    // returns. Dropping voided rows here would make a count the office knows was
    // taken simply disappear from the one manager-facing list of counts, which is
    // the failure mode soft-voiding exists to avoid — the same reasoning as the
    // /admin/inventory/anchors recovery surface.
    //
    // The void state is SURFACED instead: `voided_at` / `voided_by` ride in the
    // row so a consumer can strike it through. The pre-existing absence of a
    // `snapshot_kind` filter is left exactly as it was — this ADR does not
    // change what this endpoint returns, only what it says about each row.
    const rows = await prisma.siteInventorySnapshot.findMany({
      where: { site_id: ctx.siteId },
      orderBy: { snapshot_at: 'desc' },
      take: limit,
      select: {
        id: true,
        snapshot_at: true,
        snapshot_kind: true,
        units_indoor: true,
        units_total: true,
        units_in_processing: true,
        reconciled_delta: true,
        program_units: true,
        non_program_units: true,
        pool_attribution: true,
        voided_at: true,
        voided_by: true,
      },
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'snapshots.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;

    // ── ADR-0072 — the guardrail, enforced HERE TOO (handoff #270 Phase 3) ────
    //
    // THE GAP THIS CLOSES. ADR-0072 was wired into the iPad floor-count path
    // (`countCreate` in lib/operator/floor-writes.ts) and into the hold-release
    // path, and both were verified. This route — the Loads & Inventory desktop
    // screen's "record a physical count" form — called `reconcilePhysicalCount`
    // directly with NO tier check at all. Same table, same anchor, same total
    // authority over the floor, none of the friction.
    //
    // So the control was real but not universal, and a gated capability is only
    // as gated as its LEAST guarded entry point. A mistyped digit here replaced
    // Woodland's anchor with no confirm, no hold and no trace beyond a snapshot
    // row — which is verbatim the failure ADR-0072 was written to prevent, still
    // fully available on a surface a manager actually uses. Found while verifying
    // that tonight's EOD physical count would be guarded on whichever surface the
    // count is entered from.
    //
    // `newTotal` uses the `??` form (not `snapshotTotalUnits`'s additive sum)
    // because that is what `loadPriorAnchor` uses to derive the PRIOR total.
    // Measuring a swing between two totals computed by different rules is the
    // ADR-0078 D1 defect one level up — the two sides of a comparison must be
    // built the same way or the percentage is meaningless.
    const newTotal = (d.units_total ?? d.units_indoor ?? 0) + d.units_in_processing;
    const [prior, thresholdPct] = await Promise.all([
      loadPriorAnchor(prisma, ctx.siteId),
      loadSwingThresholdPct(prisma, ctx.siteId),
    ]);
    const classification = classifyAnchorWrite({ prior, newTotal, thresholdPct });

    if (classification.requiresManagerApproval) {
      // Tier 2 — held, not rejected and not written, exactly as the floor path
      // does it. The entered values are preserved on the hold so the work is
      // never lost to a refusal, and the release is recorded against whoever
      // approves it. Deliberately identical in shape to `countCreate`'s 422 so
      // the two surfaces cannot drift into different meanings for "held": one
      // control, two doors.
      const hold = await createHold(prisma, {
        siteId: ctx.siteId,
        createdBy: ctx.userId,
        input: {
          unitsIndoor: d.units_indoor ?? null,
          unitsTotal: d.units_total ?? null,
          unitsInProcessing: d.units_in_processing,
          programUnits: d.program_units ?? null,
          nonProgramUnits: d.non_program_units ?? null,
          poolAttribution: d.pool_attribution ?? 'measured',
        },
        classification,
      });
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
          approvers: await eligibleApprovers(prisma, ctx.siteId),
        },
        { status: 422 },
      );
    }

    const result = await reconcilePhysicalCount({
      siteId: ctx.siteId,
      // D-3: anchor the count at Pacific-midnight (00:00 PT) of the counted day, NOT
      // UTC-midnight. `${date}T00:00:00Z` is 17:00 PT the PRIOR day — it mis-dated the
      // count and made same-Pacific-day flow attribution asymmetric. See anchorFlowBounds.
      countedAt: pacificMidnightInstantOfDayISO(d.countedAt),
      physical: {
        units_indoor: d.units_indoor ?? null,
        units_total: d.units_total ?? null,
        units_in_processing: d.units_in_processing,
      },
      programUnits: d.program_units ?? null,
      nonProgramUnits: d.non_program_units ?? null,
      poolAttribution: d.pool_attribution ?? 'measured',
      actorUserId: ctx.userId,
    });
    // Tier rides back so the desktop can show the same current-vs-new context the
    // iPad does, rather than a silent 201 on a count that moved the floor 19%.
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
    // A measured split that doesn't sum to the total surfaces as 422 with the
    // plain-English reason so the office can correct the pools and resubmit.
    if (e instanceof PoolSplitMismatchError) {
      return NextResponse.json({ error: 'pool_mismatch', message: e.message }, { status: 422 });
    }
    return loadsErrorResponse(e, {
      site,
      op: 'snapshots.create',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
