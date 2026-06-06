// ADR-0019 §8 — Historical bonus-month browsing list (T-117, server component).
//
// Gated via `checkBonusAccess()` (Woodland-scoped): 401 → /login, 403 → in-place
// forbidden surface (Rick / operators land here). The list is loaded scoped to
// the caller's Woodland site (CLAUDE.md hard rule #2) through the read-only
// `@/lib/bonus/month-list` data layer.
//
// Offers a current-month / this-year / all-time filter, shows each month's state
// badge and payout total, badges AMENDED months with a link to the prior
// version, and links every row to the detail page (/bonus/months/[id]).
// English-only (ADR-0017). Money is integer cents formatted via the shared
// calculator so the figure can never diverge from the PDF/CSV.

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import { redirect } from 'next/navigation';
import { tryBonusAccess, parseSiteCode } from '@/lib/bonus/access';
import { formatCents } from '@/lib/bonus/calculator';
import {
  listBonusPayPeriods,
  parsePayPeriodFilter,
  type MonthFilter,
  type MonthListRow,
} from '@/lib/bonus/month-list';

export const dynamic = 'force-dynamic';

const FILTER_TABS: ReadonlyArray<{ key: MonthFilter; label: string }> = [
  { key: 'current', label: 'Current month' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
];

const STATE_LABEL: Record<MonthListRow['state'], string> = {
  draft: 'Draft',
  pending_signatures: 'Pending signatures',
  partially_signed: 'Partially signed',
  signed: 'Signed',
  paid: 'Paid',
  amended: 'Amended',
  skipped: 'Skipped',
};

// Badge palette — steel chips on the deep-space page; emerald for the "done"
// states (signed/paid) and a cyan accent for amended.
const STATE_BADGE: Record<MonthListRow['state'], string> = {
  draft: 'bg-dr3-steel-light/20 text-dr3-mist',
  pending_signatures: 'bg-dr3-steel-light/20 text-dr3-mist',
  partially_signed: 'bg-dr3-steel-light/30 text-dr3-mist',
  signed: 'bg-emerald-500/20 text-emerald-200',
  paid: 'bg-emerald-500/20 text-emerald-200',
  amended: 'bg-dr3-cyan/20 text-dr3-cyan',
  skipped: 'bg-dr3-steel-light/10 text-dr3-mist/60',
};

function signatureLabel(row: MonthListRow): string {
  if (row.signatureStatus === 'complete') return 'Both signed';
  if (row.signatureStatus === 'partial') {
    return row.janetteSigned ? 'Janette signed' : 'Morena signed';
  }
  return 'Unsigned';
}

export default async function BonusMonthsListPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; site?: string }>;
}) {
  const sp = await searchParams;
  const gate = await tryBonusAccess(parseSiteCode(sp.site));
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus/months');
    return <ForbiddenPage />;
  }

  const filter = parsePayPeriodFilter(sp.filter);
  const rows = await listBonusPayPeriods(gate.ctx.siteId, filter);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/bonus"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
          >
            ← Back to bonus entry
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Bonus months</h1>
          <p className="text-sm text-dr3-mist-dim">
            {gate.ctx.siteName} bonus history. Open any month to view its report and download the
            signed PDF.
          </p>
        </header>

        {/* Filter tabs (server-side links — no client JS needed) */}
        <nav className="flex flex-wrap gap-2" aria-label="Filter bonus months">
          {FILTER_TABS.map((tab) => {
            const active = tab.key === filter;
            return (
              <Link
                key={tab.key}
                href={`/bonus/months?filter=${tab.key}`}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'rounded-md bg-dr3-cyan px-3 py-1.5 text-sm font-semibold text-dr3-space'
                    : 'rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/60 px-3 py-1.5 text-sm text-dr3-mist-dim hover:bg-dr3-space-2 hover:text-dr3-mist'
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <section className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2/70 p-5">
          {rows.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">
              No bonus months {filter === 'all' ? 'yet' : 'in this period'}.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-dr3-steel-light/20">
              {rows.map((row) => (
                <li key={row.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <Link
                        href={`/bonus/months/${row.id}`}
                        className="text-base font-semibold underline-offset-4 hover:underline"
                      >
                        {row.label}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={`rounded-full px-2 py-0.5 font-medium ${STATE_BADGE[row.state]}`}
                        >
                          {STATE_LABEL[row.state]}
                        </span>
                        {row.isAmendment && (
                          <span className="rounded-full bg-dr3-cyan/20 px-2 py-0.5 font-semibold text-dr3-cyan">
                            AMENDED
                          </span>
                        )}
                        <span className="text-dr3-mist-dim">{signatureLabel(row)}</span>
                        {row.isAmendment && row.amendedFromMonthId && (
                          <Link
                            href={`/bonus/months/${row.amendedFromMonthId}`}
                            className="text-dr3-mist-dim underline underline-offset-4 hover:text-dr3-mist"
                          >
                            View prior version
                          </Link>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-medium tabular-nums">
                        {formatCents(row.totalPayoutCents)}
                      </span>
                      <Link
                        href={`/bonus/months/${row.id}`}
                        className="text-sm text-dr3-cyan underline-offset-4 hover:text-dr3-cyan-bright hover:underline"
                      >
                        Open →
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-bold">Access restricted</h1>
      <p className="mt-2 max-w-md text-sm text-dr3-mist-dim">
        Bonus management is limited to site managers and administrators.
      </p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
