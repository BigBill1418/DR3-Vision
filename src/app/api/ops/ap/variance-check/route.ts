// ADR-0046 Amendment 5 (D-M5-4) — live variance context for the Approve panel. The
// approver types a freeform vendor + confirms an amount; this returns whether that
// vendor has an ESTABLISHED baseline and, if so, the either-trips evaluation + the
// last 3 historical invoices for the RED banner. POST (not GET) so the vendor name
// stays out of URLs/logs. This is the SAME evaluation the decide route enforces —
// the banner never disagrees with the server-side gate. Advisory only; the decide
// route is the trust boundary.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import { loadVarianceContext } from '@/lib/ap/variance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  vendor?: string;
  confirmedAmountCents?: number;
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireApApprover();
    const body = (await req.json().catch(() => ({}))) as Body;
    const vendor = typeof body.vendor === 'string' ? body.vendor : '';
    const amount =
      typeof body.confirmedAmountCents === 'number' && Number.isFinite(body.confirmedAmountCents)
        ? Math.round(body.confirmedAmountCents)
        : null;
    // Nothing to evaluate without both a vendor and a confirmed amount.
    if (!vendor.trim() || amount === null || amount < 0) {
      return NextResponse.json({ established: false });
    }
    const context = await loadVarianceContext(prisma, vendor, amount);
    return NextResponse.json(context);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
