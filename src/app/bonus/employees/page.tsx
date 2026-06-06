// ADR-0019 §9 — Bonus employee management: list page (server component).
//
// Gated via `checkBonusAccess()` (Woodland-scoped): 401 → redirect to /login,
// 403 → render a forbidden surface in-place (Rick / operators land here). The
// page never trusts middleware alone (CLAUDE.md hard rule #6). URL-driven
// status filter + sort so refresh keeps state; the actual mutations happen in
// the client EmployeeManager via the gated API routes.

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import { redirect } from 'next/navigation';
import { checkBonusAccess } from '@/lib/bonus/access';
import { listEmployees, type EmployeeStatusFilter, type EmployeeSort } from '@/lib/bonus/employees';
import { EmployeeManager, type EmployeeRow } from './EmployeeManager';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ status?: string; sort?: string }>;

const STATUSES = ['active', 'inactive', 'all'] as const;
const SORTS = ['name', 'status'] as const;

function parseStatus(v: string | undefined): EmployeeStatusFilter {
  return v && (STATUSES as readonly string[]).includes(v) ? (v as EmployeeStatusFilter) : 'active';
}
function parseSort(v: string | undefined): EmployeeSort {
  return v && (SORTS as readonly string[]).includes(v) ? (v as EmployeeSort) : 'name';
}

export default async function BonusEmployeesPage({ searchParams }: { searchParams: SearchParams }) {
  const gate = await checkBonusAccess();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus/employees');
    return <ForbiddenPage />;
  }

  const sp = await searchParams;
  const status = parseStatus(sp.status);
  const sort = parseSort(sp.sort);

  const employees = await listEmployees(gate.ctx.siteId, { status, sort });
  const rows: EmployeeRow[] = employees.map((e) => ({
    id: e.id,
    full_name: e.full_name,
    previous_names: e.previous_names,
    is_active: e.is_active,
    deleted_at: e.deleted_at ? e.deleted_at.toISOString() : null,
  }));

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={HOME_ROUTE}
            className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          >
            ← Back to dashboard
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Bonus Employees</h1>
          <p className="text-sm text-dr3-cream/70">
            Woodland processor roster ({gate.ctx.siteName}). Add, rename, and (de)activate the
            employees whose daily mattress counts drive the monthly bonus.
          </p>
        </header>

        <Filters status={status} sort={sort} />

        <EmployeeManager employees={rows} />
      </div>
    </main>
  );
}

function Filters({ status, sort }: { status: EmployeeStatusFilter; sort: EmployeeSort }) {
  // URL is the state — plain links, no <form>, no client JS (CLAUDE.md #10).
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <FilterGroup label="Status">
        {STATUSES.map((s) => (
          <FilterLink key={s} href={buildHref({ status: s, sort })} active={status === s}>
            {capitalize(s)}
          </FilterLink>
        ))}
      </FilterGroup>
      <FilterGroup label="Sort by">
        {SORTS.map((s) => (
          <FilterLink key={s} href={buildHref({ status, sort: s })} active={sort === s}>
            {capitalize(s)}
          </FilterLink>
        ))}
      </FilterGroup>
    </section>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cream/60">
        {label}
      </span>
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
    ? 'bg-dr3-chartreuse text-dr3-ink'
    : 'bg-dr3-green-dark/40 text-dr3-cream hover:bg-dr3-green-dark/60';
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${cls}`}
    >
      {children}
    </Link>
  );
}

function buildHref(params: { status: EmployeeStatusFilter; sort: EmployeeSort }): string {
  const qs = new URLSearchParams();
  if (params.status !== 'active') qs.set('status', params.status);
  if (params.sort !== 'name') qs.set('sort', params.sort);
  const s = qs.toString();
  return s ? `/bonus/employees?${s}` : '/bonus/employees';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-dr3-cream/70">
        Bonus management is limited to Woodland managers and administrators.
      </p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
