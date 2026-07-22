// ADR-0046 Amendment 5 (D-M5-4) — vendor-baseline management (admin-only).
//
// Lists every computed vendor baseline (trailing-12-month mean/median/min/max/
// count) with its ESTABLISHED status (>= 3 invoices) and per-vendor threshold
// overrides. The admin sets stricter/looser bounds per vendor (Clark Pest →
// $25/6.25%) and can trigger an on-demand rebuild. Baselines are also rebuilt
// nightly and fed on every approved invoice. Admin-only per hard rule #2.

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { BASELINE_MIN_INVOICES } from '@/lib/ap/variance';
import { BaselinesClient, type BaselineRow } from './BaselinesClient';

export const dynamic = 'force-dynamic';

export default async function BaselinesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login?next=/admin/ap/baselines');
  if (session.user.role !== 'admin') {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Admin only</h1>
        <p className="mt-2 text-gray-600">Vendor-baseline management is restricted to administrators.</p>
        <Link href="/dashboard" className="mt-6 inline-block text-emerald-700 underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const rows = await prisma.apVendorBaseline.findMany({ orderBy: { vendor_display_name: 'asc' } });
  const baselines: BaselineRow[] = rows.map((b) => ({
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
  }));

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/admin" className="text-sm text-emerald-700 hover:underline">
        ← Admin
      </Link>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold text-gray-900">Vendor baselines</h1>
        <Link href="/admin/ap/baselines/import" className="text-sm text-emerald-700 hover:underline">
          Import AP report →
        </Link>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-gray-600">
        Trailing-12-month baseline per vendor, computed from Bill-uploaded AP history plus every
        Vision-approved invoice. A baseline is <strong>established</strong> (used to flag variance)
        at {BASELINE_MIN_INVOICES}+ invoices. The global thresholds are $50 flat OR 15%; set a
        per-vendor override to tighten or loosen. Overrides survive every rebuild.
      </p>

      <div className="mt-6">
        <BaselinesClient initial={baselines} />
      </div>
    </main>
  );
}
