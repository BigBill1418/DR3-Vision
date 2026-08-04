// ADR-0075 D2 — "is this already here under another spelling?"
//
// GET /api/admin/equipment/similar?siteId=…&name=…
//   -> { existing: SimilarEquipment[] }
//
// Read-only. Answers with every row at the site whose name canonicalises to the
// same form (case-folded, punctuation-stripped), INCLUDING inactive and already-
// merged rows — see `findSimilarEquipment` for why both belong in the answer.
//
// THE GATE IS DELIBERATELY NOT `requireAdmin()`. This endpoint exists to serve
// the AP equipment-request resolve panel, whose audience is a site manager
// holding `can_resolve_equipment_requests` (ADR-0046 Amendment 9) — the very
// people the old refusal message stranded by telling them to open the admin-only
// `/admin/equipment`. Gating it admin-only would rebuild that dead end one layer
// down: the manager would type a colliding name and get a bare wall again,
// because the lookup that would have offered them the alternative 403'd.
// `requireEquipmentRequestAccess()` is exactly the set that can already resolve
// these requests, and it grants no admin POWER (hard rule #2) — this route
// reads, and nothing else.
//
// SITE REACH still applies in full and is checked against the REQUESTED site
// before any row is read: a single-site manager cannot enumerate the other
// yard's registry by passing its id.
//
// Next resolves the static `similar` segment ahead of `[id]`, exactly as it does
// for the neighbouring `import` route.

import { NextResponse } from 'next/server';
import { requireEquipmentRequestAccess } from '@/lib/auth-helpers';
import { findSimilarEquipment, DISPLAY_NAME_MAX } from '@/lib/admin-equipment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await requireEquipmentRequestAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const siteId = url.searchParams.get('siteId')?.trim() ?? '';
  const name = url.searchParams.get('name')?.trim() ?? '';

  if (!siteId) return NextResponse.json({ error: 'siteId is required.' }, { status: 400 });
  // Bounded before it reaches the data layer — this is a typeahead, so the field
  // is attacker-controlled on every keystroke.
  if (name.length > DISPLAY_NAME_MAX) {
    return NextResponse.json({ error: 'name is too long.' }, { status: 400 });
  }
  if (!ctx.allSites && ctx.primarySiteId !== siteId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // An empty/punctuation-only name canonicalises to '' and yields [] rather than
  // the site's entire registry.
  const existing = await findSimilarEquipment(siteId, name);
  return NextResponse.json({ existing });
}
