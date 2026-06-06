// ADR-0017 — admin Settings panel: list page.
//
// Server component. Re-checks the admin gate (the middleware-level
// auth covers the redirect, but page handlers MUST never trust that
// alone — CLAUDE.md hard rule #6 plus the SPRINT-1 T-013 pattern).
// URL-driven filters (?site=&role=&status=) so refresh-keeps-state.

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { listUsers, type AdminUserDto } from '@/lib/admin-users';
import { adminMessages as M } from '@/app/admin/messages';
import { UserListClient } from './UserListClient';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  site?: string;
  role?: string;
  status?: string;
}>;

const ROLES = ['operator', 'manager', 'admin'] as const;
const STATUSES = ['active', 'inactive', 'all'] as const;
type RoleFilter = (typeof ROLES)[number];
type StatusFilter = (typeof STATUSES)[number];

function parseRole(v: string | undefined): RoleFilter | undefined {
  return v && (ROLES as readonly string[]).includes(v) ? (v as RoleFilter) : undefined;
}
function parseStatus(v: string | undefined): StatusFilter {
  return v && (STATUSES as readonly string[]).includes(v) ? (v as StatusFilter) : 'active';
}

export default async function AdminUsersPage({ searchParams }: { searchParams: SearchParams }) {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/users');
    return <ForbiddenPage />;
  }

  const sp = await searchParams;
  const sites = await prisma.site.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });
  const siteByCode = new Map(sites.map((s) => [s.code, s]));
  const siteFilter = sp.site ? siteByCode.get(sp.site) : undefined;
  const roleFilter = parseRole(sp.role);
  const statusFilter = parseStatus(sp.status);

  const users = await listUsers({
    siteId: siteFilter?.id,
    role: roleFilter,
    status: statusFilter,
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
              <h1 className="text-3xl font-bold tracking-tight">{M.pageTitle}</h1>
              <p className="text-sm text-dr3-mist-dim">{M.pageSubtitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href="/admin/audit"
                className="inline-flex items-center gap-2 rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-sm font-medium text-dr3-mist transition-colors hover:border-dr3-cyan/40 hover:text-dr3-cyan"
                data-testid="admin-audit-link"
              >
                {M.audit.navLink}
              </Link>
              <Link
                href="/admin/users/new"
                className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright"
                data-testid="admin-add-user"
              >
                + {M.list.addUser}
              </Link>
            </div>
          </div>
        </header>

        <Filters
          sites={sites}
          siteCode={siteFilter?.code}
          role={roleFilter}
          status={statusFilter}
        />

        <UserListClient users={users} />
      </div>
    </main>
  );
}

interface FiltersProps {
  sites: { id: string; code: string; name: string }[];
  siteCode: string | undefined;
  role: RoleFilter | undefined;
  status: StatusFilter;
}

function Filters({ sites, siteCode, role, status }: FiltersProps) {
  // Filter form is server-side: each select is a plain anchor list.
  // No `<form>` (CLAUDE.md hard rule #10) and no client JS for state
  // persistence — the URL IS the state.
  return (
    <section className="grid gap-4 sm:grid-cols-3">
      <FilterGroup label={M.list.filterSite}>
        <FilterLink href={buildHref({ site: undefined, role, status })} active={!siteCode}>
          {M.list.filterAllSites}
        </FilterLink>
        {sites.map((s) => (
          <FilterLink
            key={s.code}
            href={buildHref({ site: s.code, role, status })}
            active={siteCode === s.code}
          >
            {s.name}
          </FilterLink>
        ))}
      </FilterGroup>
      <FilterGroup label={M.list.filterRole}>
        <FilterLink href={buildHref({ site: siteCode, role: undefined, status })} active={!role}>
          {M.list.filterAllRoles}
        </FilterLink>
        {ROLES.map((r) => (
          <FilterLink
            key={r}
            href={buildHref({ site: siteCode, role: r, status })}
            active={role === r}
          >
            {capitalize(r)}
          </FilterLink>
        ))}
      </FilterGroup>
      <FilterGroup label={M.list.filterStatus}>
        <FilterLink
          href={buildHref({ site: siteCode, role, status: 'active' })}
          active={status === 'active'}
        >
          {M.list.filterStatusActive}
        </FilterLink>
        <FilterLink
          href={buildHref({ site: siteCode, role, status: 'inactive' })}
          active={status === 'inactive'}
        >
          {M.list.filterStatusInactive}
        </FilterLink>
        <FilterLink
          href={buildHref({ site: siteCode, role, status: 'all' })}
          active={status === 'all'}
        >
          {M.list.filterStatusAll}
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

function buildHref(params: {
  site: string | undefined;
  role: RoleFilter | undefined;
  status: StatusFilter;
}): string {
  const sp = new URLSearchParams();
  if (params.site) sp.set('site', params.site);
  if (params.role) sp.set('role', params.role);
  if (params.status !== 'active') sp.set('status', params.status);
  const qs = sp.toString();
  return qs ? `/admin/users?${qs}` : '/admin/users';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

export type { AdminUserDto };
