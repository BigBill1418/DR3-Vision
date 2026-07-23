// ADR-0037 D6 + §3 pool split (handoff §1.4) — manager physical-count API
// (list + record). Site-scoped + D7 activation-gated (admin-only for now). A POST
// records a `physical` snapshot as the new inventory anchor and reconciles it to the
// computed running balance; a `measured` count carries the program/non-program pool
// split, validated to sum to the physical total (a wrong split silently mis-bills MRC).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { reconcilePhysicalCount, PoolSplitMismatchError } from '@/lib/inventory/running-balance';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';
import { pacificMidnightInstantOfDayISO } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Create = z.object({
  countedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Jurisdiction-appropriate subset (CA indoor, OR total); blanks are null.
  // Outdoor is not tracked — ADR-0037 addendum (2026-07-22).
  units_indoor: z.number().int().nullable().optional(),
  units_total: z.number().int().nullable().optional(),
  units_in_processing: z.number().int().nonnegative().default(0),
  program_units: z.number().int().nonnegative().optional(),
  non_program_units: z.number().int().nonnegative().optional(),
  pool_attribution: z.enum(['measured', 'legacy']).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 50);
    const rows = await prisma.siteInventorySnapshot.findMany({
      where: { site_id: ctx.siteId },
      orderBy: { snapshot_at: 'desc' },
      take: limit,
      select: {
        id: true,
        snapshot_at: true,
        snapshot_kind: true,
        units_indoor: true,
        units_total: true,
        units_in_processing: true,
        reconciled_delta: true,
        program_units: true,
        non_program_units: true,
        pool_attribution: true,
      },
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return loadsErrorResponse(e, { site, op: 'snapshots.list', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const result = await reconcilePhysicalCount({
      siteId: ctx.siteId,
      // D-3: anchor the count at Pacific-midnight (00:00 PT) of the counted day, NOT
      // UTC-midnight. `${date}T00:00:00Z` is 17:00 PT the PRIOR day — it mis-dated the
      // count and made same-Pacific-day flow attribution asymmetric. See anchorFlowBounds.
      countedAt: pacificMidnightInstantOfDayISO(d.countedAt),
      physical: {
        units_indoor: d.units_indoor ?? null,
        units_total: d.units_total ?? null,
        units_in_processing: d.units_in_processing,
      },
      programUnits: d.program_units ?? null,
      nonProgramUnits: d.non_program_units ?? null,
      poolAttribution: d.pool_attribution ?? 'measured',
      actorUserId: ctx.userId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    // A measured split that doesn't sum to the total surfaces as 422 with the
    // plain-English reason so the office can correct the pools and resubmit.
    if (e instanceof PoolSplitMismatchError) {
      return NextResponse.json({ error: 'pool_mismatch', message: e.message }, { status: 422 });
    }
    return loadsErrorResponse(e, { site, op: 'snapshots.create', requestId: req.headers.get('x-request-id') });
  }
}
