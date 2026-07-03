// ADR-0037 D2 (Q8) — the manager verify gate route. A load cannot reach
// `verified` unless program + non-program == total_units (enforced server-side
// in verifyLoad). Investigation 1a: no verify action existed on main; this is it.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyLoad } from '@/lib/loads/verify-gate';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Both optional: omit BOTH to default the split from the load's source flag
// (Addendum B7); supply BOTH to override. The service enforces "both or neither".
const Body = z.object({
  programUnits: z.number().int().nonnegative().optional(),
  nonProgramUnits: z.number().int().nonnegative().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    await verifyLoad({
      loadId: id,
      siteId: ctx.siteId,
      verifierUserId: ctx.userId,
      ...(parsed.data.programUnits !== undefined ? { programUnits: parsed.data.programUnits } : {}),
      ...(parsed.data.nonProgramUnits !== undefined ? { nonProgramUnits: parsed.data.nonProgramUnits } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return loadsErrorResponse(e);
  }
}
