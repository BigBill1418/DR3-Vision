// ADR-0046 Amendment 9 (§2.5) — the equipment-request resolution worklist.
//
// Server component. Gate is `checkEquipmentRequestAccess()` — admin OR a site
// manager holding `can_resolve_equipment_requests`. That is a DELIBERATE
// exception to "/admin/* is admin-only"; the reasoning lives on the guard in
// `src/lib/auth-helpers.ts` and in the ADR. The API re-checks independently and
// re-derives site reach from the ROW, never from the page.
//
// Site reach (hard rule #2) is applied to the QUERY, not to the render: a
// single-site manager's list is filtered in Postgres, so an off-site row never
// reaches the browser at all.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkEquipmentRequestAccess, siteScopeFor } from '@/lib/auth-helpers';
import { listEquipmentRequests } from '@/lib/ap/equipment-requests';
import { HOME_ROUTE } from '@/lib/routes';
import { EquipmentRequestsClient } from './EquipmentRequestsClient';

export const dynamic = 'force-dynamic';

export default async function ApEquipmentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const gate = await checkEquipmentRequestAccess();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/ap/equipment-requests');
    redirect(HOME_ROUTE);
  }

  const sp = await searchParams;
  const status =
    sp.status === 'resolved' || sp.status === 'rejected' || sp.status === 'all'
      ? sp.status
      : 'open';
  const siteIds = siteScopeFor(gate.ctx);

  const [requests, allSites] = await Promise.all([
    listEquipmentRequests(prisma, { status, ...(siteIds ? { siteIds } : {}) }),
    prisma.site.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  // The resolver may only register an asset to a site they can reach.
  const sites = siteIds ? allSites.filter((s) => siteIds.includes(s.id)) : allSites;

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin/equipment"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← Equipment master
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Equipment requests</h1>
          <p className="max-w-3xl text-sm text-dr3-mist-dim">
            When an approver hits an invoice for a machine that isn’t in the fleet list yet, they
            describe it here instead of guessing. Add the asset properly, and the original invoice
            can be pointed at it. The invoice itself is already approved — nothing here changes
            that.
          </p>
        </header>

        <nav className="flex flex-wrap gap-2 text-sm">
          {(['open', 'resolved', 'rejected', 'all'] as const).map((s) => (
            <Link
              key={s}
              href={`/admin/ap/equipment-requests?status=${s}`}
              className={
                status === s
                  ? 'rounded-md bg-dr3-cyan px-3 py-1.5 font-semibold text-dr3-space'
                  : 'rounded-md border border-dr3-steel-light/25 px-3 py-1.5 text-dr3-mist-dim hover:text-dr3-cyan'
              }
            >
              {s === 'open'
                ? 'Open'
                : s === 'all'
                  ? 'All'
                  : s === 'resolved'
                    ? 'Resolved'
                    : 'Rejected'}
            </Link>
          ))}
        </nav>

        <EquipmentRequestsClient
          requests={requests.map((r) => ({
            ...r,
            requestedAt: r.requestedAt.toISOString(),
            resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
          }))}
          sites={sites}
        />
      </div>
    </main>
  );
}
