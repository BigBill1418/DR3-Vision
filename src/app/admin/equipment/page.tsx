// ADR-0063 — admin equipment master: list page (closes C-27).
//
// Server component. Re-checks the admin gate: the middleware-level auth covers
// the redirect, but a page handler MUST never trust that alone, and admin
// POWERS gate on `role === 'admin'` only — never on `all_sites` (CLAUDE.md
// hard rule #2). `checkAdmin()` is exactly that check.
//
// URL-driven filters (`?site=&category=&status=&q=`) so refresh keeps state,
// and the create/edit round trip carries them back (ADR-0017 Amendment 1,
// serialized by `./list-url`).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { listEquipment } from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { EquipmentListClient } from './EquipmentListClient';
import { EquipmentSearchClient } from './EquipmentSearchClient';
import { CATEGORY_LABEL } from './labels';
import {
  CATEGORIES,
  buildEquipmentListHref as buildHref,
  buildEquipmentListQuery,
  pickEquipmentListParams,
  withEquipmentListQuery,
  type CategoryFilter,
  type EquipmentListParams,
  type EquipmentListSearchParams,
  type StatusFilter,
} from './list-url';

export const dynamic = 'force-dynamic';

export default async function AdminEquipmentPage({
  searchParams,
}: {
  searchParams: Promise<EquipmentListSearchParams>;
}) {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/equipment');
    return <ForbiddenPage />;
  }

  const sp = await searchParams;
  const sites = await prisma.site.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });
  const siteByCode = new Map(sites.map((s) => [s.code, s]));
  const view = pickEquipmentListParams(sp);
  const siteFilter = view.site ? siteByCode.get(view.site) : undefined;

  // The view state the create/edit round trip must carry and hand back, so
  // saving returns the admin to the list they were working in rather than the
  // unfiltered registry. `site` is normalised to the resolved code so an
  // unknown `?site=` doesn't ride along.
  const normalizedView: EquipmentListParams = { ...view, site: siteFilter?.code };
  const listQuery = buildEquipmentListQuery(normalizedView);

  const equipment = await listEquipment({
    siteId: siteFilter?.id,
    category: view.category,
    status: view.status,
    q: view.q,
  });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={HOME_ROUTE}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {M.backToDashboard}
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{M.equipment.pageTitle}</h1>
              <p className="text-sm text-dr3-mist-dim">{M.equipment.pageSubtitle}</p>
            </div>
            <Link
              href={withEquipmentListQuery('/admin/equipment/new', normalizedView)}
              className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright"
              data-testid="admin-add-equipment"
            >
              + {M.equipment.addEquipment}
            </Link>
          </div>
          {/* The neighbouring /admin/equipment/import surface writes a DIFFERENT
              table (equipment_events, ADR-0048 D3). Say so once, here, so an
              admin hunting for downtime history doesn't edit the asset master. */}
          <p className="text-xs text-dr3-mist-dim">
            {M.equipment.terexImportNote}{' '}
            <Link
              href="/admin/equipment/import"
              className="underline underline-offset-4 hover:text-dr3-cyan"
              data-testid="admin-equipment-terex-link"
            >
              {M.equipment.terexImportLink}
            </Link>
          </p>
          {/* ADR-0046 Amendment 9 (§2.5) — the sibling worklist. An admin who lands
              here to add an asset is often here BECAUSE an approver asked for one;
              the queue of those asks belongs one click away, not only on `/`. */}
          <p className="text-xs text-dr3-mist-dim">
            Approvers can flag equipment that isn’t on this list yet.{' '}
            <Link
              href="/admin/ap/equipment-requests"
              className="underline underline-offset-4 hover:text-dr3-cyan"
              data-testid="admin-equipment-requests-link"
            >
              Equipment requests
            </Link>
          </p>
        </header>

        <Filters
          sites={sites}
          siteCode={siteFilter?.code}
          category={view.category}
          status={view.status}
          q={view.q}
        />

        <EquipmentSearchClient view={normalizedView} />

        <EquipmentListClient equipment={equipment} listQuery={listQuery} />
      </div>
    </main>
  );
}

interface FiltersProps {
  sites: { id: string; code: string; name: string }[];
  siteCode: string | undefined;
  category: CategoryFilter | undefined;
  status: StatusFilter;
  q: string | undefined;
}

function Filters({ sites, siteCode, category, status, q }: FiltersProps) {
  // Server-side filter bar: each option is a plain anchor. No `<form>`
  // (CLAUDE.md hard rule #10) and no client JS for persistence — the URL IS
  // the state. Every href carries the other three params so filters compose.
  return (
    <section className="grid gap-4 sm:grid-cols-3">
      <FilterGroup label={M.equipment.filterSite}>
        <FilterLink href={buildHref({ site: undefined, category, status, q })} active={!siteCode}>
          {M.equipment.filterAllSites}
        </FilterLink>
        {sites.map((s) => (
          <FilterLink
            key={s.code}
            href={buildHref({ site: s.code, category, status, q })}
            active={siteCode === s.code}
          >
            {s.name}
          </FilterLink>
        ))}
      </FilterGroup>
      <FilterGroup label={M.equipment.filterCategory}>
        <FilterLink
          href={buildHref({ site: siteCode, category: undefined, status, q })}
          active={!category}
        >
          {M.equipment.filterAllCategories}
        </FilterLink>
        {CATEGORIES.map((c) => (
          <FilterLink
            key={c}
            href={buildHref({ site: siteCode, category: c, status, q })}
            active={category === c}
          >
            {CATEGORY_LABEL[c]}
          </FilterLink>
        ))}
      </FilterGroup>
      <FilterGroup label={M.equipment.filterStatus}>
        <FilterLink
          href={buildHref({ site: siteCode, category, status: 'active', q })}
          active={status === 'active'}
        >
          {M.equipment.filterStatusActive}
        </FilterLink>
        <FilterLink
          href={buildHref({ site: siteCode, category, status: 'inactive', q })}
          active={status === 'inactive'}
        >
          {M.equipment.filterStatusInactive}
        </FilterLink>
        <FilterLink
          href={buildHref({ site: siteCode, category, status: 'all', q })}
          active={status === 'all'}
        >
          {M.equipment.filterStatusAll}
        </FilterLink>
      </FilterGroup>
    </section>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cyan">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const cls = active
    ? 'bg-dr3-cyan text-dr3-space'
    : 'border border-dr3-steel-light/30 bg-dr3-space-2 text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan';
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${cls}`}
    >
      {children}
    </Link>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{M.forbiddenHeading}</h1>
      <p className="mt-2 text-dr3-mist-dim">{M.forbiddenBody}</p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
      >
        {M.backToDashboard}
      </Link>
    </main>
  );
}
