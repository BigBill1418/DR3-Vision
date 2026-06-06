// T-014 — admin audit log viewer.
//
// Server component. Mirrors the gate + layout conventions of
// `/admin/users` (page-layer `checkAdmin`, page-level redirect on 401,
// in-page 403 surface for non-admin sessions). URL params drive the
// state — the client filter form pushes new URLs and this server
// component re-renders.
//
// The audit log is append-only (CLAUDE.md hard rule #6, ADR-0007); no
// surface here ever offers an edit / delete affordance.

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import { redirect } from 'next/navigation';
import { checkAdmin } from '@/lib/auth-helpers';
import { listAuditEntries, listAuditActorOptions, LINKABLE_TABLES } from '@/lib/admin-audit';
import {
  parseAuditParams,
  isoDateBounds,
  buildAuditQueryString,
  defaultDateRange,
} from '@/lib/admin-audit-url';
import { adminMessages as M } from '@/app/admin/messages';
import { AuditFilters, type AuditFilterDraft } from './AuditFilters';
import { AuditList, type AuditListRow } from './AuditList';
import { AuditPagination } from './AuditPagination';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  actor?: string;
  table?: string;
  from?: string;
  to?: string;
  action?: string;
  page?: string;
}>;

interface PageProps {
  searchParams: SearchParams;
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/audit');
    return <ForbiddenPage />;
  }

  const sp = await searchParams;
  const state = parseAuditParams({
    actor: sp.actor,
    table: sp.table,
    from: sp.from,
    to: sp.to,
    action: sp.action,
    page: sp.page,
  });

  // If neither bound was supplied, default to the last 7 days. We do
  // NOT inject the defaults into the URL (that would break the "URL
  // is the state" contract); the server applies them silently and
  // the filter UI shows them as the active draft.
  const noDateGiven = state.from === null && state.to === null;
  const defaults = noDateGiven ? defaultDateRange() : null;
  const fromIso = state.from ?? defaults?.from ?? null;
  const toIso = state.to ?? defaults?.to ?? null;
  const bounds = isoDateBounds(fromIso, toIso);

  const [actors, page] = await Promise.all([
    listAuditActorOptions(),
    listAuditEntries({
      filters: {
        actor_user_id: state.actor ?? undefined,
        table_name: state.table ?? undefined,
        from: bounds.from ?? undefined,
        to: bounds.to ?? undefined,
        actions: state.actions.length > 0 ? state.actions : undefined,
      },
      page: state.page,
      per_page: 50,
    }),
  ]);

  const filterDraft: AuditFilterDraft = {
    actor: state.actor,
    table: state.table,
    from: fromIso,
    to: toIso,
    actions: state.actions,
  };

  // Table dropdown lists every linkable table plus any table_name
  // observed in the current result page (so an admin can filter for
  // 'pin_audit_extra' if `writeAudit` ever emits one without us
  // updating the constant). Sorted, deduped.
  const observedTables = Array.from(new Set(page.rows.map((r) => r.table_name)));
  const tableSet = new Set<string>([...LINKABLE_TABLES, ...observedTables]);
  const tableOptions = Array.from(tableSet)
    .sort()
    .map((t) => ({ value: t, label: t }));

  const hrefForPage = (n: number): string => {
    const qs = buildAuditQueryString({
      actor: state.actor,
      table: state.table,
      from: state.from,
      to: state.to,
      actions: state.actions,
      page: n,
    });
    return qs ? `/admin/audit?${qs}` : '/admin/audit';
  };

  // Serialize the rows for the client component. Date -> ISO string.
  const clientRows: AuditListRow[] = page.rows.map((r) => ({
    id: r.id,
    created_at: r.created_at.toISOString(),
    action: r.action,
    table_name: r.table_name,
    row_id: r.row_id,
    actor_user: r.actor_user,
    actor_label: r.actor_label,
    ip: r.ip,
    user_agent: r.user_agent,
    before: r.before,
    after: r.after,
    row_exists: r.row_exists,
  }));

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin/users"
            className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          >
            ← {M.pageTitle}
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{M.audit.pageTitle}</h1>
              <p className="text-sm text-dr3-cream/70">{M.audit.pageSubtitle}</p>
            </div>
          </div>
        </header>

        <AuditFilters initial={filterDraft} actors={actors} tables={tableOptions} />

        <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
          {page.total === 0
            ? M.audit.empty
            : `${M.audit.summary(page.total)} · ${M.audit.pageOf(page.page, page.total_pages)}`}
        </p>

        <AuditList rows={clientRows} />

        {page.total_pages > 1 ? (
          <AuditPagination
            page={page.page}
            totalPages={page.total_pages}
            prevHref={page.page > 1 ? hrefForPage(page.page - 1) : null}
            nextHref={page.page < page.total_pages ? hrefForPage(page.page + 1) : null}
          />
        ) : null}
      </div>
    </main>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
      <h1 className="text-2xl font-semibold">{M.forbiddenHeading}</h1>
      <p className="mt-2 text-dr3-cream/70">{M.forbiddenBody}</p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
      >
        {M.backToDashboard}
      </Link>
    </main>
  );
}
