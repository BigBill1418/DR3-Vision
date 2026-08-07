// ADR-0078 — the audited half of "Discard" on the conflicts screen.
//
// Discarding is the one resolution that DESTROYS an operator's work, so it may
// not be a purely local IndexedDB delete. The row leaves no trace anywhere else
// — a refused entry never reached a table — so if this endpoint does not record
// it, the fact that an operator entered a count and then threw it away is
// unrecoverable, and unrecoverable is exactly what CLAUDE.md hard rule #6 exists
// to prevent for anything money-adjacent.
//
// The client removes its local row ONLY after this returns 2xx. That ordering is
// deliberate: audit-then-delete can at worst leave a discarded entry visible for
// one more sweep, while delete-then-audit can lose the record entirely.
//
// This writes to `audit_log` and to nothing else. It is not a write path for the
// entry's payload — a discarded count is discarded.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireActivatedOperator, loadsErrorResponse } from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { writeAudit } from '@/lib/audit';
import { isQueueId } from '@/lib/ulid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  site_code: z.string().min(1).max(64),
  scope: z.string().min(1).max(64),
  idempotency_key: z.string().refine(isQueueId, 'malformed idempotency key').nullable(),
  target_day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  last_error: z.string().max(200).nullable(),
  /** Why the operator discarded it. Required, so the row says something. */
  reason: z.string().trim().min(1).max(500),
});

export async function POST(req: Request) {
  let site = '';
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    const d = parsed.data;
    site = d.site_code;

    // Gated on the queue surface the conflicts screen itself rides, and the
    // actor comes from the session — a discard is attributed to whoever is
    // signed in, never to whatever the body claims.
    const ctx = await requireActivatedOperator(d.site_code, UI_SURFACE.IPAD_QUEUE);

    await writeAudit({
      actor_user_id: ctx.userId,
      action: 'delete',
      table_name: 'offline_queue',
      // No database row was ever written, so there is no row id to name. The
      // idempotency key IS the entry's identity; where even that is missing (a
      // legacy v1 row) we say so rather than inventing one.
      row_id: d.idempotency_key ?? 'unkeyed',
      before: {
        scope: d.scope,
        target_day: d.target_day,
        last_error: d.last_error,
        site_id: ctx.siteId,
      },
      after: { discarded: true, reason: d.reason },
    });

    return NextResponse.json({ discarded: true });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'queue.discard',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
