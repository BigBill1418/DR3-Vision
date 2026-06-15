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
import { tryBonusAccess, parseSiteCode } from '@/lib/bonus/access';
import { listEmployees, type EmployeeStatusFilter, type EmployeeSort } from '@/lib/bonus/employees';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary, translate } from '@/i18n/dictionary';
import { EmployeeManager, type EmployeeRow } from './EmployeeManager';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ status?: string; sort?: string; site?: string }>;

const STATUSES = ['active', 'inactive', 'all'] as const;
const SORTS = ['name', 'status'] as const;

function parseStatus(v: string | undefined): EmployeeStatusFilter {
  return v && (STATUSES as readonly string[]).includes(v) ? (v as EmployeeStatusFilter) : 'active';
}
function parseSort(v: string | undefined): EmployeeSort {
  return v && (SORTS as readonly string[]).includes(v) ? (v as EmployeeSort) : 'name';
}

export default async function BonusEmployeesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  const t: Translate = (key, vars) => translate(dict, key, vars);

  const gate = await tryBonusAccess(parseSiteCode(sp.site));
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus/employees');
    return <ForbiddenPage t={t} />;
  }

  const status = parseStatus(sp.status);
  const sort = parseSort(sp.sort);

  const employees = await listEmployees(gate.ctx.siteId, { status, sort });
  const rows: EmployeeRow[] = employees.map((e) => ({
    id: e.id,
    full_name: e.full_name,
    employee_number: e.employee_number,
    previous_names: e.previous_names,
    is_active: e.is_active,
    deleted_at: e.deleted_at ? e.deleted_at.toISOString() : null,
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={HOME_ROUTE}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
          >
            {t('bonus_employees.back_to_dashboard')}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{t('bonus_employees.page_title')}</h1>
          <p className="text-sm text-dr3-mist-dim">
            {t('bonus_employees.page_subtitle', { name: gate.ctx.siteName })}
          </p>
        </header>

        <Filters status={status} sort={sort} t={t} />

        <EmployeeManager employees={rows} />
      </div>
    </main>
  );
}

const STATUS_LABEL_KEY: Record<EmployeeStatusFilter, string> = {
  active: 'bonus_employees.status_active',
  inactive: 'bonus_employees.status_inactive',
  all: 'bonus_employees.status_all',
};
const SORT_LABEL_KEY: Record<EmployeeSort, string> = {
  name: 'bonus_employees.sort_name',
  status: 'bonus_employees.sort_status',
};

function Filters({
  status,
  sort,
  t,
}: {
  status: EmployeeStatusFilter;
  sort: EmployeeSort;
  t: Translate;
}) {
  // URL is the state — plain links, no <form>, no client JS (CLAUDE.md #10).
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <FilterGroup label={t('bonus_employees.filter_status')}>
        {STATUSES.map((s) => (
          <FilterLink key={s} href={buildHref({ status: s, sort })} active={status === s}>
            {t(STATUS_LABEL_KEY[s])}
          </FilterLink>
        ))}
      </FilterGroup>
      <FilterGroup label={t('bonus_employees.filter_sort')}>
        {SORTS.map((s) => (
          <FilterLink key={s} href={buildHref({ status, sort: s })} active={sort === s}>
            {t(SORT_LABEL_KEY[s])}
          </FilterLink>
        ))}
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
    : 'border border-dr3-steel-light/25 bg-dr3-space-2/60 text-dr3-mist-dim hover:bg-dr3-space-2 hover:text-dr3-mist';
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

function ForbiddenPage({ t }: { t: Translate }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{t('bonus_employees.forbidden_heading')}</h1>
      <p className="mt-2 text-dr3-mist-dim">{t('bonus_employees.forbidden_body')}</p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
      >
        {t('bonus_employees.back_to_dashboard')}
      </Link>
    </main>
  );
}
