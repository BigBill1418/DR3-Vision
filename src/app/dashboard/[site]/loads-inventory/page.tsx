// ADR-0037 D3/D4/D6 — manager loads & inventory surfaces (CRUD-lite).
//
// Site-scoped (CLAUDE.md hard rule #2) via requireManagerForSite. D7 activation
// gate: admin-only for now (schema + surfaces merge, but only admins see them
// until the ops gates close). English-first is acceptable here — this is a
// manager/office surface, NOT an operator iPad surface.
//
// The header shows the ONE pool-aware running balance (D6) so the manager sees
// program / non-program / total on hand, computed from verified inbound +
// drop-offs − stripped − whole units sold − landfilled since the latest physical
// count (Addendum B4).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { onHand } from '@/lib/inventory/running-balance';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { LoadsInventoryClient } from './LoadsInventoryClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function LoadsInventoryPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/loads-inventory`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">This area is restricted.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // D7 activation gate (data-driven, ADR-0047) — admins always pass; operators/
  // managers pass only when the per-site `loads_inventory` surface is flipped
  // `live`. Default/pilot/unregistered ⇒ admin-only (unchanged historical behavior).
  const loadsInventoryLive = await isUiSurfaceLive(
    UI_SURFACE.LOADS_INVENTORY,
    result.ctx.siteId,
  );
  if (result.ctx.role !== 'admin' && !loadsInventoryLive) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Not yet activated</h1>
        <p className="mt-2 max-w-md opacity-80">
          The loads &amp; inventory surfaces (ADR-0037) are staged but not yet activated for this
          site. Admin access only until an admin flips the <code>loads_inventory</code> rollout
          surface live.
        </p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // ADR-0047 UI gate — the events/OR-counts tabs ramp via `loads_events_or_tabs`
  // (admins always see them; this page is otherwise gated by the D7 surface above).
  const eventsOrTabsLive = await isUiSurfaceLive(
    UI_SURFACE.LOADS_EVENTS_OR_TABS,
    result.ctx.siteId,
  );
  const showEventsOrTabs = result.ctx.role === 'admin' || eventsOrTabsLive;

  const balance = await onHand(result.ctx.siteId, new Date());

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {result.ctx.siteName} dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Loads &amp; inventory — {result.ctx.siteName}
        </h1>

        <div className="mt-6 grid grid-cols-3 gap-4">
          <BalanceTile label="Program on hand" value={balance.program.toString()} accent />
          <BalanceTile label="Non-program on hand" value={balance.nonProgram.toString()} />
          <BalanceTile label="Total on hand" value={balance.total.toString()} />
        </div>
        <p className="mt-2 text-xs opacity-70">
          Running balance (D6): End = Start + Inbound − Stripped − Whole units sold − Landfilled.
          Anchored to the latest physical count, plus verified inbound + drop-offs, minus stripped
          (processed), renovation whole units sold, and landfilled units. Baled / shredded
          commodities never subtract units.
        </p>

        <LoadsInventoryClient
          siteCode={siteCode}
          showEventsOrTabs={showEventsOrTabs}
          computedTotal={balance.total.toString()}
        />
      </div>
    </main>
  );
}

function BalanceTile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-4 ${accent ? 'border-dr3-cyan/50 bg-black/20' : 'border-white/15 bg-black/10'}`}
    >
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}
