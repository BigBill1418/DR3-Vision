// ADR-0052 — commodity payment reconciliation (Daven's view). Org reach only
// (admin OR all_sites manager); both sites, aging, CSV. Born on the deep-space
// theme (ADR-0051) — no green here.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { hasOrgReach } from '@/lib/ops/reach';
import { listCommodityPayments } from '@/lib/commodity-payments/payments';
import { CommodityPaymentsClient } from './CommodityPaymentsClient';

export const dynamic = 'force-dynamic';

export default async function CommodityPaymentsPage() {
  const identity = await currentOpsViewer();
  if (!identity) redirect('/login?next=/dashboard/ops/commodity-payments');
  if (!hasOrgReach(identity.viewer)) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">
          Commodity payment reconciliation is for admins and all-sites managers.
        </p>
        <Link href="/" className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const [rows, sites] = await Promise.all([
    listCommodityPayments(),
    prisma.site.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-7xl">
        <Link href="/" className="text-sm underline opacity-90">
          ← Back to dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Commodity payments</h1>
        <p className="mt-1 text-sm opacity-75">
          Every outbound load and where its money stands — invoice it, mark it paid, and nothing we
          sell goes unpaid without us seeing it age.
        </p>
        <CommodityPaymentsClient initialRows={rows} sites={sites} />
      </div>
    </main>
  );
}
