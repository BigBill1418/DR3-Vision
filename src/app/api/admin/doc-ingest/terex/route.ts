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
//
// ADR-0077 moved the decision itself into `decideTerexBatch` so the one
// non-HTTP caller (the one-off that accepted the first batch, at Bill's written
// instruction) drives the SAME audited code rather than a hand-written
// `updateMany` that would skip the totals capture. THE GATE DID NOT MOVE: this
// route still requires an admin session, and it is still the only way in from
// the network.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkAdmin } from '@/lib/auth-helpers';
import { decideTerexBatch } from '@/lib/doc-ingest/terex-decide';
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

  const result = await decideTerexBatch(body.action, {
    versionId: body.versionId,
    actor: { userId: gate.ctx.userId },
    ...(body.action === 'discard' ? { reason: body.reason } : {}),
  });

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });

  log.info(
    { versionId: body.versionId, rows: result.rows, actor: gate.ctx.userId },
    `[terex] staged batch ${result.action === 'confirm' ? 'confirmed' : 'discarded'}`,
  );

  return result.action === 'confirm'
    ? NextResponse.json({ confirmed: result.rows, totals: result.totals })
    : NextResponse.json({ discarded: result.rows });
}
