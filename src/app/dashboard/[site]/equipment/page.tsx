// ADR-0044 D3 — the Terex equipment trend view (manager/office surface).
//
// Site-scoped (CLAUDE.md hard rule #2) via `checkManagerForSite`. This is a plain
// manager surface — NOT behind the ADR-0037 D7 loads/inventory activation gate;
// any manager on their own site (or an admin / all-sites manager) reaches it.
// English-first is acceptable here — office desktop, not an operator iPad.
// Working surfaces stay on the green palette (ADR-0014/0008).
//
// Throughput is DERIVED server-side (D2) and handed to the client for rendering;
// the event log is fetched by the client so entry/void refreshes without a full
// page reload.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { computeEquipmentThroughput } from '@/lib/equipment/throughput';
import { EquipmentClient } from './EquipmentClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function EquipmentPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/equipment`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-white">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">This area is restricted to {siteCode} managers.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const throughput = await computeEquipmentThroughput(result.ctx.siteId, { windowDays: 90 });

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-10 text-white">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {result.ctx.siteName} dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Equipment — {result.ctx.siteName}</h1>
        <p className="mt-1 text-sm opacity-70">
          Terex throughput, downtime, and cost. Throughput is derived from the daily processed-units
          close — the same number billing bills from; nothing is entered twice.
        </p>

        <EquipmentClient siteCode={siteCode} throughput={throughput} />
      </div>
    </main>
  );
}
