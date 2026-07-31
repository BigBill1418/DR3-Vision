// ADR-0069 Amendment 2 — confirm or discard a staged TEREX batch.
//
// The human half of preview-then-confirm. Rows arrive `staged`; nothing counts
// until somebody with admin rights accepts them, and the acceptance is
// attributed. A CHECK constraint enforces that a confirmed row names who
// confirmed it — money data whose acceptance cannot answer "who accepted this?"
// is not an audit trail.
//
// The batch is a VERSION, not a row. Asking a human to tick 80 maintenance
// events individually guarantees they stop reading them; showing the totals and
// the de-duplication, then taking one decision, is the review that actually
// happens.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { writeAudit } from '@/lib/audit';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), versionId: z.string().min(1) }),
  z.object({
    action: z.literal('discard'),
    versionId: z.string().min(1),
    reason: z.string().min(1).max(500),
  }),
]);

export async function POST(req: Request): Promise<Response> {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const body = parsed.data;
  const now = new Date();

  const staged = await prisma.docTerexMaintenanceRow.findMany({
    where: { doc_source_version_id: body.versionId, status: 'staged' },
    select: { id: true, actual_repair_cost: true, amount_credited: true, estimated_cost: true },
  });
  if (staged.length === 0) {
    // Not an error worth a 500 — most likely somebody else just decided it.
    return NextResponse.json({ error: 'nothing_staged' }, { status: 409 });
  }

  const sum = (pick: (r: (typeof staged)[number]) => unknown): number =>
    staged.reduce((a, r) => a + Number(pick(r) ?? 0), 0);
  const totals = {
    actual_repair_cost: sum((r) => r.actual_repair_cost),
    amount_credited: sum((r) => r.amount_credited),
    estimated_cost: sum((r) => r.estimated_cost),
  };

  if (body.action === 'confirm') {
    const res = await prisma.docTerexMaintenanceRow.updateMany({
      where: { doc_source_version_id: body.versionId, status: 'staged' },
      data: { status: 'confirmed', confirmed_at: now, confirmed_by: gate.ctx.userId },
    });
    await writeAudit({
      actor_user_id: gate.ctx.userId,
      action: 'update',
      table_name: 'doc_terex_maintenance_rows',
      row_id: body.versionId,
      after: {
        confirmed: true,
        rows: res.count,
        // The figures AS ACCEPTED. If a later read disagrees, this row says what
        // the person was actually looking at when they said yes.
        totals_accepted: totals,
      },
    });
    log.info(
      { versionId: body.versionId, rows: res.count, actor: gate.ctx.userId },
      '[terex] staged batch confirmed',
    );
    return NextResponse.json({ confirmed: res.count, totals });
  }

  const res = await prisma.docTerexMaintenanceRow.updateMany({
    where: { doc_source_version_id: body.versionId, status: 'staged' },
    data: {
      status: 'discarded',
      discarded_at: now,
      discarded_by: gate.ctx.userId,
      discard_reason: body.reason,
    },
  });
  await writeAudit({
    actor_user_id: gate.ctx.userId,
    action: 'update',
    table_name: 'doc_terex_maintenance_rows',
    row_id: body.versionId,
    after: { discarded: true, rows: res.count, reason: body.reason, totals_rejected: totals },
  });
  log.info(
    { versionId: body.versionId, rows: res.count, actor: gate.ctx.userId },
    '[terex] staged batch discarded',
  );
  return NextResponse.json({ discarded: res.count });
}
