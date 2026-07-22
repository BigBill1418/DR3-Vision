// ADR-0037 Phase 3 (§3.3 Option B) — manager daily-close ENTRY surface.
//
// Managers ENTER and AMEND their site's processed-units day; BILL CLOSES AND LOCKS
// it. That boundary is the money-safe line and it is enforced structurally, not by
// convention:
//
//   - There is NO close handler under `/api/manager/**`. Closing a day exists in
//     exactly one place, `POST /api/admin/processed-units/[id]/close`, which is
//     super-admin gated. Do not add a close route here.
//   - `upsertProcessedUnits` refuses any write to an already-closed day (typed 409),
//     so a manager can amend right up to the close and never past it.
//
// Site-scoped + D7 activation-gated via `requireActivatedManager`, exactly like the
// other manager loads/inventory routes. The admin route (`/api/admin/processed-units`)
// is untouched and retains full entry + close authority.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { upsertProcessedUnits, listProcessedUnits } from '@/lib/loads/processed-units';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  productionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strippedProgram: z.number().nonnegative(),
  strippedNonProgram: z.number().nonnegative(),
  savedUnits: z.number().nonnegative().nullable().optional(),
  materialTicketNumber: z.string().max(120).nullable().optional(),
  employeesCount: z.number().int().nonnegative().nullable().optional(),
  processorsCount: z.number().int().nonnegative().nullable().optional(),
  pocketcoilEstimate: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 60);
    return NextResponse.json({ rows: await listProcessedUnits(ctx.siteId, limit) });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'manager.processed-units.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await upsertProcessedUnits({
      siteId: ctx.siteId,
      productionDate: new Date(`${d.productionDate}T00:00:00Z`),
      strippedProgram: d.strippedProgram,
      strippedNonProgram: d.strippedNonProgram,
      savedUnits: d.savedUnits ?? null,
      materialTicketNumber: d.materialTicketNumber ?? null,
      employeesCount: d.employeesCount ?? null,
      processorsCount: d.processorsCount ?? null,
      pocketcoilEstimate: d.pocketcoilEstimate ?? null,
      actorUserId: ctx.userId,
      notes: d.notes ?? null,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    // ProcessedUnitsError carries {status, reason} — loadsErrorResponse surfaces it
    // as-is (a closed day => 409 `closed`), so no special-casing is needed here.
    return loadsErrorResponse(e, {
      site,
      op: 'manager.processed-units.upsert',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
