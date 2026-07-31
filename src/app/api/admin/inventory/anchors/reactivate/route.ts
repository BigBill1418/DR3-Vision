// ADR-0072 §3 — anchor recovery.
//
// Anchors are append-only (`site_inventory_snapshots` is a history, not a
// mutable row), which is what makes a bad overwrite recoverable at all. Recovery
// therefore RE-ACTIVATES a prior anchor by writing a NEW snapshot carrying its
// figures — it never edits or deletes the bad one.
//
// That distinction is the whole point. Deleting the mistake would leave a
// history that never contained it, and the next person to ask "why did the floor
// jump 1,200 units on the 31st?" would find nothing. The chain reads: the good
// anchor, the bad one, and the correction — with the audit row naming who
// decided and which snapshot they restored from.
//
// Admin only. This is the one action in the app that can move the whole floor
// without counting anything.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { reconcilePhysicalCount } from '@/lib/inventory/running-balance';
import { pacificDayISO, pacificMidnightInstantOfDayISO } from '@/lib/time';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  snapshotId: z.string().min(1),
  reason: z.string().min(1).max(500),
});

export async function POST(req: Request): Promise<Response> {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'snapshot_and_reason_required' }, { status: 422 });
  }

  const restoreFrom = await prisma.siteInventorySnapshot.findUnique({
    where: { id: parsed.data.snapshotId },
    select: {
      id: true,
      site_id: true,
      units_indoor: true,
      units_total: true,
      units_in_processing: true,
      program_units: true,
      non_program_units: true,
      pool_attribution: true,
      snapshot_kind: true,
    },
  });
  if (!restoreFrom) return NextResponse.json({ error: 'snapshot_not_found' }, { status: 404 });
  // Only a physical count is a meaningful anchor to restore to.
  if (restoreFrom.snapshot_kind !== 'physical') {
    return NextResponse.json({ error: 'not_a_physical_anchor' }, { status: 422 });
  }

  try {
    const result = await reconcilePhysicalCount({
      siteId: restoreFrom.site_id,
      countedAt: pacificMidnightInstantOfDayISO(pacificDayISO(new Date())),
      physical: {
        units_indoor: restoreFrom.units_indoor,
        units_total: restoreFrom.units_total,
        units_in_processing: restoreFrom.units_in_processing,
      },
      programUnits: restoreFrom.program_units === null ? null : Number(restoreFrom.program_units),
      nonProgramUnits:
        restoreFrom.non_program_units === null ? null : Number(restoreFrom.non_program_units),
      poolAttribution: restoreFrom.pool_attribution === 'legacy' ? 'legacy' : 'measured',
      actorUserId: gate.ctx.userId,
    });

    await prisma.auditLog.create({
      data: {
        actor_user_id: gate.ctx.userId,
        action: 'insert',
        table_name: 'site_inventory_snapshots',
        row_id: result.snapshotId,
        after: {
          anchor_reactivation: true,
          restored_from_snapshot_id: restoreFrom.id,
          reason: parsed.data.reason,
          physical_total: result.physicalTotal,
          reconciled_delta: result.reconciledDelta,
        },
      },
    });

    log.warn(
      {
        site: restoreFrom.site_id,
        restoredFrom: restoreFrom.id,
        newSnapshot: result.snapshotId,
        actor: gate.ctx.userId,
      },
      '[anchor-recovery] prior anchor re-activated as a new snapshot',
    );

    return NextResponse.json({
      restored: true,
      snapshotId: result.snapshotId,
      physicalTotal: result.physicalTotal,
      reconciledDelta: result.reconciledDelta,
    });
  } catch (e) {
    log.error({ err: e }, '[anchor-recovery] re-activation failed');
    return NextResponse.json({ error: 'reactivate_failed' }, { status: 500 });
  }
}
