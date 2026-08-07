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
import { computeTerexLedger, siteMachineLabel } from '@/lib/equipment/terex-ledger';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { prisma } from '@/lib/prisma';
import { EquipmentClient } from './EquipmentClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function EquipmentPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/equipment`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">This area is restricted to {siteCode} managers.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // ADR-0047 UI gate — entry and trend ramp independently. In pilot both stay
  // admin-only; the trend view stays admin even after event ENTRY goes live (§8
  // Stage 2 separation) until `equipment_trend` is flipped too.
  const isAdmin = result.ctx.role === 'admin';
  const [entryLive, trendLive, ledgerLive] = await Promise.all([
    isUiSurfaceLive(UI_SURFACE.EQUIPMENT_ENTRY, result.ctx.siteId),
    isUiSurfaceLive(UI_SURFACE.EQUIPMENT_TREND, result.ctx.siteId),
    isUiSurfaceLive(UI_SURFACE.EQUIPMENT_TEREX_LEDGER, result.ctx.siteId),
  ]);
  const showEntry = isAdmin || entryLive;
  const showTrend = isAdmin || trendLive;

  if (!showEntry && !showTrend) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Not yet activated</h1>
        <p className="mt-2 max-w-md opacity-80">
          The equipment surface (ADR-0044) is staged but not yet activated for managers at this
          site. Admin access only until it is ramped from the rollout panel (ADR-0047).
        </p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const throughput = await computeEquipmentThroughput(result.ctx.siteId, { windowDays: 90 });

  // ADR-0077 Amendment 1 — the spec asked for this surface to be NAMED for the
  // machine. Derived, never hardcoded: Woodland reads "Terex", Eugene keeps the
  // generic name rather than advertising a machine it does not have.
  const machineLabel = await siteMachineLabel(result.ctx.siteId);

  // ADR-0077 D6 — the machine-ledger entry point. The heading above stays
  // GENERIC (this is the site's equipment surface; a second machine joins it
  // tomorrow) and the per-machine story lives one level down.
  //
  // Only offered when the caller can actually open it: pilot ⇒ admin-only, so a
  // manager is never shown a link that lands on "Not yet activated". Merged-away
  // rows are excluded — their attribution has moved to the survivor.
  const machines =
    isAdmin || ledgerLive
      ? await prisma.equipment.findMany({
          where: {
            site_id: result.ctx.siteId,
            category: 'terex',
            is_active: true,
            merged_into_id: null,
            // …AND the Terex invoices actually resolve here. `category: 'terex'`
            // alone is the ADR-0062 seed's category for SHEAR MACHINES — four of
            // the five such rows in production are `EQ## — Shear Machine`, one of
            // them at Eugene, none with a ledger worth opening. Mirrors
            // `isSiteTerexMachine` in the ledger, which refuses them outright.
            links: { some: {} },
          },
          select: { id: true, display_name: true },
          orderBy: { display_name: 'asc' },
        })
      : [];

  // ADR-0081 — the machine metrics band. Bill: "populate this terex page with
  // relevant data metrics for this equipment."
  //
  // REUSES `computeTerexLedger` rather than querying the three tables here. That
  // module carries the guards the totals depend on — confirmed rows only, ONE
  // absorbed revision only (the difference between $77,067.94 and $231,203.82),
  // and the `isSiteTerexMachine` refusal of the four `terex`-CATEGORY shear
  // machines — and those guards are pinned against exactly one implementation.
  //
  // Gated identically to `machines` above, and not by a second rule: the band
  // renders the ledger surface's own numbers, so offering it wider than the
  // ledger would ramp that surface past its ADR-0047 gate as a side effect.
  // Site-scoped on `result.ctx.siteId` (hard rule #2) — the machine id comes from
  // the site-scoped query above and the ledger re-checks the pairing itself.
  const terexMachine = machines[0];
  const ledger = terexMachine
    ? await computeTerexLedger(result.ctx.siteId, terexMachine.id, { isAdmin })
    : null;

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {result.ctx.siteName} dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          {machineLabel} — {result.ctx.siteName}
        </h1>
        {/* ADR-0081 — this sentence used to say throughput was "derived from the
            daily processed-units close". ADR-0079 removed that derivation (the
            close is the WHOLE FLOOR's output, not this machine's) and ADR-0081
            added nineteen months of the machine's own sheet history beside the
            entered days. Leaving the old copy would have described the one
            behaviour the last two ADRs exist to remove. */}
        <p className="mt-1 text-sm opacity-70">
          Throughput, downtime, and cost — this machine&rsquo;s own daily units and run hours, as
          entered here and as imported from the Terex workbook.
        </p>

        <EquipmentClient
          siteCode={siteCode}
          throughput={throughput}
          showTrend={showTrend}
          showEntry={showEntry}
          machines={machines.map((m) => ({ id: m.id, displayName: m.display_name }))}
          machineLabel={machineLabel}
          ledger={ledger}
        />
      </div>
    </main>
  );
}
