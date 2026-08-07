// ADR-0078 D4 — the offline-queue replay endpoint.
//
// This route did not exist. `replayAll()` in `src/lib/offline-queue.ts` has been
// POSTing to `/api/queue/replay` since T-009; Next answered 404, the queue's
// hard-4xx branch classified that as a CONFLICT, and a conflict is never
// retried. So every queued action was permanently stuck the first time it was
// tried — silently, because nothing surfaced conflicts to anyone. (The blast
// radius was zero only because `enqueueAction` had no callers either. Both ends
// of the same missing feature; fixing one without the other would have turned a
// dormant bug into a live one.)
//
// ## What this endpoint is, and what it deliberately is not
//
// It is NOT a generic "run this server action" bridge. A queued body is
// attacker-influenced input that has been sitting on a shared iPad, so:
//
//   - `scope` must be in the `FLOOR_SCOPES` allowlist. An unknown scope is 400
//     `unknown_scope`, never a dynamic dispatch to a name the body chose.
//   - Identity is re-derived from the SESSION via `requireActivatedOperator` —
//     the same gate, on the same per-surface rollout flag, that the live route
//     for that scope uses. A `site_code` in the body only selects which site's
//     gate to check; it can never grant reach the session does not have.
//   - The target day is pinned with `assertCurrentPacificDay` BEFORE dispatch.
//     A stale entry is refused with 422 `date_not_today` and stays in the queue
//     as a conflict for a person to resolve. It is never retargeted to today and
//     never dropped: the first silently mis-files a count against the wrong
//     production day, the second silently loses the operator's work, and the
//     whole point of ADR-0078 is that neither happens quietly.
//   - The idempotency key rides through, so a replay of a write that DID land
//     before the response was lost returns the original response and writes
//     nothing.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireActivatedOperator,
  loadsErrorResponse,
  assertCurrentPacificDay,
} from '@/lib/loads/route-helpers';
import { FLOOR_SCOPES, isFloorScope } from '@/lib/operator/floor-writes';
import { isQueueId } from '@/lib/ulid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ReplayEnvelope = z.object({
  scope: z.string().min(1).max(64),
  site_code: z.string().min(1).max(64),
  /** Minted when the action was first ATTEMPTED, so the replay names that write. */
  idempotency_key: z.string().refine(isQueueId, 'malformed idempotency key').nullable(),
  /** The day the entry was FOR. Null only for scopes that are not day-addressed. */
  target_day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  payload: z.unknown(),
});

export async function POST(req: Request) {
  let site = '';
  try {
    const parsed = ReplayEnvelope.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_envelope' }, { status: 400 });
    }
    const env = parsed.data;
    site = env.site_code;

    // Allowlist FIRST — before any gate is consulted, so an unknown scope can
    // never be distinguished from a known one by timing or by error shape.
    if (!isFloorScope(env.scope)) {
      return NextResponse.json({ error: 'unknown_scope' }, { status: 400 });
    }
    const def = FLOOR_SCOPES[env.scope];

    // The same gate the live route for this scope applies, resolved from the
    // scope — not from anything the queued body said about it.
    const ctx = await requireActivatedOperator(env.site_code, def.surface);

    // The day pin, before dispatch. `targetDay` reads the day out of the PAYLOAD
    // rather than trusting the envelope's `target_day`, so an entry cannot
    // declare one day in its envelope and carry another in its body. The
    // envelope's copy exists for the conflicts UI, which must be able to say
    // which day an entry was for without parsing a scope-specific payload.
    const day = def.targetDay(env.payload);
    if (def.dayAddressed) {
      // A day-addressed payload with NO day is refused, not exempted. The
      // earlier shape (`if (day !== null) assert…`) meant an entry whose day
      // field was missing — an old-format queue row, or one edited by hand —
      // skipped the pin completely and was written against today. That is the
      // exact silent retarget D10 exists to prevent, reachable through the one
      // path that has no operator watching it.
      if (day === null) {
        return NextResponse.json({ error: 'date_not_today' }, { status: 422 });
      }
      assertCurrentPacificDay(day);
    }

    const result = await def.handler({
      ctx,
      payload: env.payload,
      idempotencyKey: env.idempotency_key,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'queue.replay',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
