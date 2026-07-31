// ADR-0072 §3 — anchor history and recovery.
//
// The safety net for the whole guardrail. Tiers 1 and 2 make a bad overwrite
// unlikely; this makes one survivable. Because `site_inventory_snapshots` is
// append-only, every anchor a site has ever had is still here, and restoring one
// is a matter of writing a new snapshot carrying its figures — never editing or
// deleting the bad row.
//
// Also lists PENDING holds, because a count waiting for a manager is invisible
// everywhere else in the admin surface: the operator sees it on the iPad they
// entered it on, and nobody else would know it exists.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { AnchorsClient } from './anchors-client';

export const dynamic = 'force-dynamic';

function pacific(d: Date): string {
  return `${d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  })} PT`;
}

function total(row: {
  units_indoor: number | null;
  units_total: number | null;
  units_in_processing: number;
}): number {
  return (row.units_total ?? row.units_indoor ?? 0) + row.units_in_processing;
}

export default async function AnchorsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">Anchor recovery is restricted to administrators.</p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const [snapshots, holds, sites] = await Promise.all([
    prisma.siteInventorySnapshot.findMany({
      where: { snapshot_kind: 'physical' },
      orderBy: { snapshot_at: 'desc' },
      take: 60,
      select: {
        id: true,
        site_id: true,
        snapshot_at: true,
        units_indoor: true,
        units_total: true,
        units_in_processing: true,
        program_units: true,
        non_program_units: true,
        reconciled_delta: true,
        site: { select: { code: true, name: true } },
      },
    }),
    prisma.inventoryCountHold.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        created_at: true,
        prior_total: true,
        new_total: true,
        swing_pct: true,
        threshold_pct: true,
        site: { select: { code: true, name: true } },
      },
    }),
    prisma.inventoryAnchorConfig.findMany({
      select: { swing_threshold_pct: true, site: { select: { code: true, name: true } } },
    }),
  ]);

  const rows = snapshots.map((s) => ({
    id: s.id,
    siteCode: s.site.code,
    siteName: s.site.name,
    at: pacific(s.snapshot_at),
    total: total(s),
    programUnits: s.program_units === null ? null : Number(s.program_units),
    nonProgramUnits: s.non_program_units === null ? null : Number(s.non_program_units),
    reconciledDelta: s.reconciled_delta,
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link href="/admin" className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist">
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Inventory anchors</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          A physical count becomes the anchor every downstream number is computed forward from.
          Anchors are append-only, so a bad one is recoverable: re-activating a prior anchor writes
          a <strong>new</strong> snapshot carrying its figures — the mistake stays in the history
          rather than being erased, so the record still explains what happened.
        </p>

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-dr3-mist-dim">
          {sites.map((c) => (
            <span
              key={c.site.code}
              className="rounded-full bg-dr3-steel/30 px-3 py-1 ring-1 ring-dr3-steel-light/20"
            >
              {c.site.name}: manager approval above{' '}
              <strong>{Number(c.swing_threshold_pct)}%</strong> swing
            </span>
          ))}
        </div>

        {holds.length > 0 && (
          <section className="mt-6">
            <h2 className="text-lg font-semibold">Counts waiting for a manager</h2>
            <p className="mt-1 text-sm text-dr3-mist-dim">
              Entered on the floor and held. Nothing has been written to inventory.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg ring-1 ring-amber-500/30">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-amber-500/10 text-xs uppercase tracking-wide text-amber-200">
                  <tr>
                    <th className="px-3 py-2">Site</th>
                    <th className="px-3 py-2">Entered</th>
                    <th className="px-3 py-2 text-right">On record</th>
                    <th className="px-3 py-2 text-right">Counted</th>
                    <th className="px-3 py-2 text-right">Swing</th>
                  </tr>
                </thead>
                <tbody>
                  {holds.map((h) => (
                    <tr key={h.id} className="border-t border-amber-500/20" data-testid="hold-row">
                      <td className="px-3 py-2">{h.site.name}</td>
                      <td className="px-3 py-2 text-xs text-dr3-mist-dim">
                        {pacific(h.created_at)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {h.prior_total.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {h.new_total.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-300">
                        {Number(h.swing_pct).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <AnchorsClient rows={rows} />
      </div>
    </main>
  );
}
