// Sprint-1 T-016 — per-item resolution writer.
//
// POST /api/reconciliation/{site}/items/{itemId}/resolve
//   body: { resolution: 'dr3_correct' | 'mymrc_correct' | 'flag_followup',
//           notes?: string }
//
// Auth: `requireManagerForSite(site)` AND a second cross-check
// inside `resolveReconciliationItem` that the item's parent
// reconciliation belongs to that site. The double-check defends
// against a coding mistake in the route layer ever leaking a write
// across sites — a Eugene manager hitting
// /api/reconciliation/eugene/items/<woodland-item-id>/resolve will
// be 404'd, not silently allowed through.
//
// Every resolution writes one mymrc_reconciliation_items update +
// one audit_log row in the same Prisma transaction. CLAUDE.md hard
// rule #6 (audit append-only) — never delete or update the audit
// row; on a state-change re-resolution we append a fresh row.
// Hard rule #10 — client posts via fetch().

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { resolveReconciliationItem } from '@/lib/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  resolution: z.enum(['dr3_correct', 'mymrc_correct', 'flag_followup']),
  notes: z.string().max(2000).optional().nullable(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ site: string; itemId: string }> }
) {
  const { site: siteCode, itemId } = await ctx.params;

  let auth;
  try {
    auth = await requireManagerForSite(siteCode);
  } catch (gateErr) {
    if (gateErr instanceof Response) return gateErr;
    throw gateErr;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = req.headers.get('user-agent') ?? null;

  const result = await resolveReconciliationItem({
    itemId,
    siteId: auth.siteId,
    resolverUserId: auth.userId,
    resolution: parsed.data.resolution,
    notes: parsed.data.notes ?? null,
    ip,
    userAgent,
  });

  if (!result.ok) {
    if (result.reason === 'not_found' || result.reason === 'wrong_site') {
      // Treat both as 404 from the client's perspective so we don't
      // leak whether the item exists at another site.
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: result.reason }, { status: 422 });
  }

  return NextResponse.json({ item: result.item }, { status: 200 });
}
