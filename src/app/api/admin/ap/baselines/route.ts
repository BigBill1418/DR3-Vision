// ADR-0046 Amendment 5 (D-M5-4) — vendor-baseline list (admin-only).
//
// Backs the /admin/ap/baselines management surface's client refresh (the SSR page
// reads the same rows directly). Admin-only (hard rule #2) — baseline management is
// an accounting/admin function, not a rostered-approver one.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { BASELINE_MIN_INVOICES } from '@/lib/ap/variance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const rows = await prisma.apVendorBaseline.findMany({
    orderBy: { vendor_display_name: 'asc' },
  });
  return NextResponse.json({
    baselines: rows.map((b) => ({
      vendorNameNormalized: b.vendor_name_normalized,
      vendorDisplayName: b.vendor_display_name,
      invoiceCount: b.invoice_count,
      established: b.invoice_count >= BASELINE_MIN_INVOICES,
      meanAmountCents: b.mean_amount_cents,
      medianAmountCents: b.median_amount_cents,
      minAmountCents: b.min_amount_cents,
      maxAmountCents: b.max_amount_cents,
      stddevAmountCents: b.stddev_amount_cents,
      varianceFlatOverrideCents: b.variance_flat_override_cents,
      variancePercentOverride:
        b.variance_percent_override != null ? Number(b.variance_percent_override) : null,
      computedAtISO: b.computed_at.toISOString(),
    })),
  });
}
