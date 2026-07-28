// ADR-0046 Amendment 5 (D-M5-6) — the site-filtered equipment option list for the
// Approve-panel multi-select. Reads the ACTIVE `equipment` master for the decision's
// site (resolved from the 'eugene'/'woodland' code). Approver-scoped (same guard as
// the decide route). The approver may only REFERENCE these rows — creation is
// admin-only (hard rule #3), so this endpoint is read-only.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import { resolveDecisionSiteId, ApInvalidSiteError } from '@/lib/ap/approvals';
import { listSiteEquipment } from '@/lib/ap/equipment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    await requireApApprover();
    // The option list is FLEET-WIDE as of 2026-07-28 (operator directive
    // overriding ADR-0046 Amendment 5 D-M5-6) — see `lib/ap/equipment.ts`.
    //
    // `site` is still accepted and still validated when present, because the
    // Approve panel only reaches this endpoint once a real site is chosen and a
    // bad code should still fail loudly rather than silently widen. It no longer
    // narrows the results.
    const site = new URL(req.url).searchParams.get('site');
    if (site && site.trim()) {
      const siteId = await resolveDecisionSiteId(prisma, site);
      if (!siteId) return NextResponse.json({ error: 'unknown site' }, { status: 400 });
    }
    const options = await listSiteEquipment(prisma);
    return NextResponse.json({ options });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ApInvalidSiteError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
