// ADR-0104 §D5 — confirm or discard a staged outbound weight batch.
//
// The human half of preview-then-confirm. Rows arrive `staged`; nothing counts
// until somebody with admin rights accepts them, and the acceptance is
// attributed. The batch is a VERSION, not a row — asking a human to tick 831
// loads individually guarantees they stop reading them; showing the totals, the
// de-duplication and the sign check, then taking one decision, is the review
// that actually happens.
//
// The decision itself lives in `decideOutboundBatch` so that a non-HTTP caller
// (the ADR-0077 D1 precedent: a one-off run under a written operator
// instruction) drives the SAME audited code rather than a hand-written
// `updateMany` that would skip the totals capture and the audit row. THE GATE
// DOES NOT MOVE: this route still requires an admin session, and it is still the
// only way in from the network.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkAdmin } from '@/lib/auth-helpers';
import { decideOutboundBatch } from '@/lib/doc-ingest/outbound-decide';
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

  const result = await decideOutboundBatch(body.action, {
    versionId: body.versionId,
    actor: { userId: gate.ctx.userId },
    ...(body.action === 'discard' ? { reason: body.reason } : {}),
  });

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });

  log.info(
    {
      versionId: body.versionId,
      rows: result.rows,
      commodityRows: result.commodityRows,
      actor: gate.ctx.userId,
    },
    `[outbound] staged batch ${result.action === 'confirm' ? 'confirmed' : 'discarded'}`,
  );

  return result.action === 'confirm'
    ? NextResponse.json({
        confirmed: result.rows,
        commodityRows: result.commodityRows,
        totals: result.totals,
      })
    : NextResponse.json({ discarded: result.rows, commodityRows: result.commodityRows });
}
