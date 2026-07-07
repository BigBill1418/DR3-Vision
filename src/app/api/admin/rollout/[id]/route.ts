// ADR-0047 — admin rollout-surface flip endpoint. Admin-role only (NOT
// all_sites, NOT super-admin — an admin power per CLAUDE.md hard rule #2).
// A flip requires a criteria note and is audited + immediate.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { flipRolloutSurface, RolloutFlipError } from '@/lib/notify/flip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  toState: z.enum(['pilot', 'live']),
  criteriaNote: z.string().min(1),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }

  try {
    const updated = await flipRolloutSurface({
      surfaceId: id,
      toState: parsed.data.toState,
      criteriaNote: parsed.data.criteriaNote,
      actorUserId: admin.userId,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json({
      surface: {
        id: updated.id,
        surface_code: updated.surface_code,
        rollout_state: updated.rollout_state,
        flipped_at: updated.flipped_at,
        criteria_note: updated.criteria_note,
      },
    });
  } catch (e) {
    if (e instanceof RolloutFlipError) return NextResponse.json({ error: e.reason }, { status: e.status });
    throw e;
  }
}
