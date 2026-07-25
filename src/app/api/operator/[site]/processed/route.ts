// ADR-0060 F-4 (P2) — iPad FLOOR processed / stripped count confirmation API.
//
// Confirm-ONLY: the floor confirms/corrects the day's core stripped counts
// (`strippedProgram` + `strippedNonProgram`) via the SAME `upsertProcessedUnits` money
// path the manager desktop uses. Payroll-adjacent fields (employees, processors,
// pocketcoil, material ticket, saved units) stay on the manager surface — the floor
// confirms the count, not the payroll inputs. Close/lock stays admin-only:
// `upsertProcessedUnits` already refuses a closed day (typed 409), so that boundary holds.
//
// Operator-PIN gated + ADR-0047 rollout-gated via `requireActivatedOperator`.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { upsertProcessedUnits } from '@/lib/loads/processed-units';
import { requireActivatedOperator, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  productionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strippedProgram: z.number().nonnegative(),
  strippedNonProgram: z.number().nonnegative(),
  notes: z.string().max(2000).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedOperator(site);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await upsertProcessedUnits({
      siteId: ctx.siteId,
      productionDate: new Date(`${d.productionDate}T00:00:00Z`),
      strippedProgram: d.strippedProgram,
      strippedNonProgram: d.strippedNonProgram,
      actorUserId: ctx.userId,
      notes: d.notes ?? null,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    // ProcessedUnitsError carries {status, reason} — a closed day surfaces as 409 `closed`.
    return loadsErrorResponse(e, {
      site,
      op: 'operator.processed.confirm',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
