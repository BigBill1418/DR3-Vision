// ADR-0060 F-4 (P2) — iPad FLOOR processed / stripped count confirmation API.
//
// Confirm-ONLY: the floor confirms/corrects the day's core stripped counts
// (`strippedProgram` + `strippedNonProgram`) via the SAME `upsertProcessedUnits` money
// path the manager desktop uses. Payroll-adjacent fields (employees, processors,
// pocketcoil, material ticket, saved units) stay on the manager surface — the floor
// confirms the count, not the payroll inputs. Close/lock stays admin-only:
// `upsertProcessedUnits` already refuses a closed day (typed 409), so that boundary holds.
//
// Operator-PIN gated + ADR-0047 rollout-gated via `requireActivatedOperator` on the
// per-surface `ipad_processed` gate (ADR-0065), not the shared `loads_inventory` master gate.

// ADR-0078 — a TRANSPORT over `processedConfirm` (src/lib/operator/floor-writes.ts),
// which the offline-queue replay endpoint dispatches through as well.

import { NextResponse } from 'next/server';
import {
  requireActivatedOperator,
  loadsErrorResponse,
  assertCurrentPacificDay,
  readIdempotencyKey,
} from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { ProcessedConfirm, processedConfirm } from '@/lib/operator/floor-writes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_PROCESSED);
    const idempotencyKey = readIdempotencyKey(req);
    const parsed = ProcessedConfirm.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    // ADR-0065 — current Pacific day only (same floor rule as /inbound).
    assertCurrentPacificDay(parsed.data.productionDate);
    const result = await processedConfirm({ ctx, payload: parsed.data, idempotencyKey });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    // ProcessedUnitsError carries {status, reason} — a closed day surfaces as 409 `closed`.
    return loadsErrorResponse(e, {
      site,
      op: 'operator.processed.confirm',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
