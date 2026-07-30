// ADR-0069 — /admin/doc-ingest/reconciliation: spreadsheet figure vs. Vision figure.
//
// The one page in the doc-ingest subtree that a SITE MANAGER can open, and
// deliberately so. The rest are admin-only because they list sources whose
// `site_id` is NULL, and an unclassified document must not reach a site-scoped
// view. Nothing here is unscoped: every row comes from `doc_reference_rows`, whose
// `site_id` is NOT NULL by schema constraint. And the person who can say whether
// the workbook or Vision is right for a given day is the manager who was there.
//
// Site reach is resolved SERVER-SIDE from the session (hard rule #2). The client
// sends a period, never a site id — a site id in a query string is a request, not
// an authorisation.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkReconciliationRead, reconciliationSiteIds } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import { reconcileReference } from '@/lib/doc-ingest/reconciliation';
import { appTodayISO } from '@/lib/time';
import { ReconciliationClient } from './ReconciliationClient';

export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Default window: the current Pacific month to date.
 *
 * `appTodayISO()` is the only correct source for "today" here. The container runs
 * UTC, so `new Date().toISOString().slice(0,10)` is tomorrow's date for seven
 * hours of every Pacific evening — six manager screens were just corrected for
 * exactly that defect.
 */
function defaultWindow(): { from: string; to: string } {
  const today = appTodayISO();
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** A malformed or client-supplied bound falls back to the default, never throws. */
function bound(raw: string | string[] | undefined, fallback: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && ISO_DAY.test(value) ? value : fallback;
}

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): Promise<JSX.Element> {
  const gate = await checkReconciliationRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/doc-ingest/reconciliation');
    redirect('/dashboard');
  }

  const defaults = defaultWindow();
  const from = bound(searchParams['from'], defaults.from);
  const to = bound(searchParams['to'], defaults.to);

  const siteIds = await reconciliationSiteIds(gate.ctx);
  const result = await reconcileReference({ db: prisma, siteIds, from, to });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={gate.ctx.via === 'admin' ? '/admin/doc-ingest' : '/dashboard'}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {gate.ctx.via === 'admin' ? M.sources.title : AM.backToDashboard}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.reconciliation.title}</h1>
          <p className="text-sm text-dr3-mist-dim">{M.reconciliation.subtitle}</p>
        </header>
        <ReconciliationClient
          rows={result.rows}
          summaries={result.summaries}
          from={result.from}
          to={result.to}
        />
      </div>
    </main>
  );
}
