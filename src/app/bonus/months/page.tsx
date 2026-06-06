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
import { redirect } from 'next/navigation';
import { checkBonusAccess } from '@/lib/bonus/access';
import { formatCents } from '@/lib/bonus/calculator';
import {
  listBonusMonths,
  parseMonthFilter,
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
};

// Badge palette — dark chips on the deep-green page, chartreuse accent for the
// "done" states (signed/paid) and amended.
const STATE_BADGE: Record<MonthListRow['state'], string> = {
  draft: 'bg-dr3-cream/15 text-dr3-cream',
  pending_signatures: 'bg-dr3-cream/15 text-dr3-cream',
  partially_signed: 'bg-dr3-cream/20 text-dr3-cream',
  signed: 'bg-dr3-chartreuse text-dr3-ink',
  paid: 'bg-dr3-chartreuse text-dr3-ink',
  amended: 'bg-dr3-chartreuse/80 text-dr3-ink',
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
  searchParams: Promise<{ filter?: string }>;
}) {
  const gate = await checkBonusAccess();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus/months');
    return <ForbiddenPage />;
  }

  const sp = await searchParams;
  const filter = parseMonthFilter(sp.filter);
  const rows = await listBonusMonths(gate.ctx.siteId, filter);

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/bonus"
            className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          >
            ← Back to bonus entry
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Bonus months</h1>
          <p className="text-sm text-dr3-cream/70">
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
                    ? 'rounded-md bg-dr3-chartreuse px-3 py-1.5 text-sm font-semibold text-dr3-ink'
                    : 'rounded-md bg-dr3-green-dark/40 px-3 py-1.5 text-sm text-dr3-cream/80 hover:bg-dr3-green-dark/60 hover:text-dr3-cream'
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <section className="rounded-lg bg-dr3-green-dark/40 p-5">
          {rows.length === 0 ? (
            <p className="text-sm text-dr3-cream/70">
              No bonus months {filter === 'all' ? 'yet' : 'in this period'}.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-dr3-cream/10">
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
                          <span className="rounded-full bg-dr3-chartreuse/80 px-2 py-0.5 font-semibold text-dr3-ink">
                            AMENDED
                          </span>
                        )}
                        <span className="text-dr3-cream/60">{signatureLabel(row)}</span>
                        {row.isAmendment && row.amendedFromMonthId && (
                          <Link
                            href={`/bonus/months/${row.amendedFromMonthId}`}
                            className="text-dr3-cream/70 underline underline-offset-4 hover:text-dr3-cream"
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
                        className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
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
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
      <h1 className="text-2xl font-bold">Access restricted</h1>
      <p className="mt-2 max-w-md text-sm text-dr3-cream/70">
        Bonus management is limited to Woodland managers and administrators.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
