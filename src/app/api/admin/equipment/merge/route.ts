// ADR-0075 D4 — collapse two records of one machine onto a survivor.
//
// POST /api/admin/equipment/merge  { winnerId, loserId }
//   -> { ok: true, winner, repointedLinks, repointedRequests }
//
// ADMIN-ONLY, unlike its sibling `similar` route. Detecting a duplicate is
// something the resolve panel's whole audience must be able to do; DECLARING two
// records to be the same physical machine is a judgement about financial
// evidence — every invoice that cited the loser silently starts naming the
// winner — and it is not reversible from the UI. That belongs on `role ===
// 'admin'` (hard rule #2: admin POWERS never ride on `all_sites`).
//
// The handler re-checks the gate itself. The page layer's `checkAdmin()` covers
// the UI surface and NOTHING ELSE.
//
// What a merge moves, and what it must never touch, is documented on
// `mergeEquipment` — attribution only; `ap_requests` is never written.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { mergeEquipment, type MergeFailure } from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { actorFrom } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mergeSchema = z.object({
  winnerId: z.string().min(1),
  loserId: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }

  const parsed = mergeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: M.errors.invalidPayload, details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const result = await mergeEquipment(
    parsed.data.winnerId,
    parsed.data.loserId,
    actorFrom(req, ctx.userId),
  );
  if (!result.ok) return mergeFailureResponse(result.reason);

  return NextResponse.json({
    ok: true,
    winner: result.winner,
    repointedLinks: result.repointedLinks,
    repointedRequests: result.repointedRequests,
  });
}

function mergeFailureResponse(reason: MergeFailure): NextResponse {
  switch (reason) {
    case 'not_found':
      return NextResponse.json({ error: M.equipment.notFound }, { status: 404 });
    case 'same_row':
      return NextResponse.json({ error: M.equipment.mergeSameRow }, { status: 422 });
    case 'cross_site':
      return NextResponse.json({ error: M.equipment.mergeCrossSite }, { status: 422 });
    case 'winner_merged':
    case 'loser_merged':
      return NextResponse.json({ error: M.equipment.mergeAlreadyMerged }, { status: 409 });
    default:
      return NextResponse.json({ error: M.errors.serverError }, { status: 500 });
  }
}
