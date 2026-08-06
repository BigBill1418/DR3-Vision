// ADR-0077 D6 — the Terex machine ledger read API. GET ONLY.
//
// There is no POST/PATCH/DELETE here and there is not meant to be: the ledger
// READS `doc_terex_maintenance_rows`, `ap_equipment_links` and `equipment_events`
// and writes none of them. Absorption is the single writer of the first,
// the AP decision path of the second, the ADR-0044 event service of the third.
// A write verb on this route would be a second writer to money data.
//
// Auth is the ADR-0077 gate, not `requireManagerForSite`: this surface is
// narrower than "any manager at this site" (see the gate's own header for why
// role/all_sites and the ap_approvers roster both select the wrong set). Site
// reach is then re-checked against the EQUIPMENT ROW's site, so editing the
// `[site]` segment cannot reach the other jurisdiction's asset.

import { NextResponse } from 'next/server';
import { checkEquipmentLedgerAccess, ledgerReaches } from '@/lib/auth-helpers';
import { computeTerexLedger } from '@/lib/equipment/terex-ledger';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site: siteCode } = await params;

  const access = await checkEquipmentLedgerAccess();
  if (!access.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: access.status });
  }

  const equipmentId = new URL(req.url).searchParams.get('equipmentId');
  if (!equipmentId) {
    return NextResponse.json({ error: 'equipmentId required' }, { status: 400 });
  }

  const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  // Reach is checked against the site the ASSET lives at.
  if (!ledgerReaches(access.ctx, site.id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const ledger = await computeTerexLedger(site.id, equipmentId, { isAdmin: access.ctx.isAdmin });
  // A merged-away or off-site id is indistinguishable from a missing one here,
  // deliberately: both are "no such machine at this site".
  if (!ledger.equipment) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  return NextResponse.json({ ledger });
}
