// ADR-0075 D2 — "is this already here under another spelling?"
//
// GET /api/admin/equipment/similar?q=…[&unit=…&vin=…&type=…&search=1]
//   -> { existing: SimilarEquipment[] }
//
// Read-only. ADR-0135 A/B: the shared unit-aware matcher over the WHOLE FLEET
// (both yards — trailers move), ranked VIN > same name > same unit number >
// shared words. `search=1` includes word matches (the resolve panel's "Find it
// in the fleet"); without it only probable duplicates come back (the create
// form's "already in the fleet?" hint). `name` is accepted as a legacy alias of
// `q`; `siteId` is accepted and ignored (the lookup is fleet-wide now).
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
// SITE REACH (hard rule #2) — ADR-0135 made this lookup fleet-wide on purpose.
// The registry's names are not site-private: every AP approver at either site
// already sees every active asset in the fleet-wide picker (ADR-0046 Amendment
// 7). Scoping the lookup to one yard is precisely what hid 281577 at Woodland
// from a Eugene resolver and let it be created twice. Nothing site-scoped
// (loads, money, people) is exposed here — only the asset list.
//
// Next resolves the static `similar` segment ahead of `[id]`, exactly as it does
// for the neighbouring `import` route.

import { NextResponse } from 'next/server';
import { requireEquipmentRequestAccess } from '@/lib/auth-helpers';
import { searchEquipment, DISPLAY_NAME_MAX } from '@/lib/admin-equipment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    await requireEquipmentRequestAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const p = (k: string) => url.searchParams.get(k)?.trim() ?? '';
  const q = p('q') || p('name');
  const unit = p('unit');
  const vin = p('vin');
  const type = p('type');
  // Bounded before it reaches the data layer — this is a typeahead, so every
  // field is attacker-controlled on every keystroke.
  if ([q, unit, vin, type].some((v) => v.length > DISPLAY_NAME_MAX)) {
    return NextResponse.json({ error: 'query is too long.' }, { status: 400 });
  }

  // An empty/punctuation-only query yields [] rather than the entire registry.
  const existing = await searchEquipment(
    {
      text: [unit, q].filter(Boolean).join(' '),
      ...(unit ? { unitNumber: unit } : {}),
      ...(vin ? { vinSerial: vin } : {}),
      ...(type ? { assetType: type } : {}),
    },
    { includeWordMatches: p('search') === '1', limit: p('search') === '1' ? 15 : 10 },
  );
  return NextResponse.json({ existing });
}
