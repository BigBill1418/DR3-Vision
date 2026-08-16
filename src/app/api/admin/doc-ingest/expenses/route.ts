// ADR-0104 §D5 — confirm or discard a staged facility-expense batch.
//
// Same shape and same gate as the TEREX and outbound routes. This document
// carries money ($974,928.36 across the two Woodland sheets), so nothing counts
// until an admin accepts the batch and the acceptance is attributed.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkAdmin } from '@/lib/auth-helpers';
import { decideFacilityExpenseBatch } from '@/lib/doc-ingest/facility-expense-decide';
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

  const result = await decideFacilityExpenseBatch(body.action, {
    versionId: body.versionId,
    actor: { userId: gate.ctx.userId },
    ...(body.action === 'discard' ? { reason: body.reason } : {}),
  });

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });

  log.info(
    { versionId: body.versionId, rows: result.rows, actor: gate.ctx.userId },
    `[expenses] staged batch ${result.action === 'confirm' ? 'confirmed' : 'discarded'}`,
  );

  return result.action === 'confirm'
    ? NextResponse.json({ confirmed: result.rows, totals: result.totals })
    : NextResponse.json({ discarded: result.rows });
}
