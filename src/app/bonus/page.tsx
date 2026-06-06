// ADR-0019 §4/§7 — Bonus daily-entry page (T-105, server component).
//
// Gated via `checkBonusAccess()` (Woodland-scoped): 401 → redirect to /login,
// 403 → render the forbidden surface in-place (Rick / operators land here). The
// page never trusts middleware alone (CLAUDE.md hard rule #6).
//
// Loads (or creates, via the T-106 `getOrCreateDraftMonth` inside the data
// layer) the current month's draft for Woodland, lists ACTIVE employees
// alphabetically, and pre-loads today's row. The Woodland processor-bonus rule
// is resolved server-side and passed to the client grid so live bonus math is
// rule-driven, never hardcoded (CLAUDE.md hard rule #3).

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import { redirect } from 'next/navigation';
import { checkBonusAccess } from '@/lib/bonus/access';
import { getDailyGrid } from '@/lib/bonus/daily-entry';
import {
  appToday,
  appTodayISO,
  dayKeyUTCFromISO,
  dayISO,
  pacificMonthLabel,
  pacificDateLabel,
} from '@/lib/time';
import { DailyEntryGrid, type GridRowProps } from './DailyEntryGrid';
import { AdminDatePicker } from './AdminDatePicker';
import { CloseMonthButton } from './CloseMonthButton';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ date?: string }>;

/**
 * Resolve the business day this page edits. Default is Pacific "today". An admin
 * (Bill) may override it via ?date=YYYY-MM-DD to backfill any prior day; the
 * picker is admin-only and the write is re-checked server-side in the API. Any
 * malformed or non-admin override falls back to today.
 */
function resolveEntryDate(raw: string | undefined, isAdmin: boolean): Date {
  if (!isAdmin || !raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return appToday();
  try {
    return dayKeyUTCFromISO(raw);
  } catch {
    return appToday();
  }
}

export default async function BonusDailyEntryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const gate = await checkBonusAccess();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus');
    return <ForbiddenPage />;
  }

  const sp = await searchParams;
  const entryDate = resolveEntryDate(sp.date, gate.ctx.isAdmin);
  const grid = await getDailyGrid(gate.ctx.siteId, entryDate);

  const rows: GridRowProps[] = grid.rows.map((r) => ({
    bonus_employee_id: r.bonus_employee_id,
    full_name: r.full_name,
    mattress_count: r.mattress_count,
    note: r.note,
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={HOME_ROUTE}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
          >
            ← Back to dashboard
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Daily Bonus Entry</h1>
          <p className="text-sm text-dr3-mist-dim">
            {gate.ctx.siteName} processor mattress counts for{' '}
            <span className="font-medium text-dr3-mist">{pacificDateLabel(grid.entryDate)}</span>.
            Counts drive each processor&rsquo;s daily bonus; the note is optional and never affects
            the math.
          </p>
          {gate.ctx.isAdmin ? (
            <AdminDatePicker selected={dayISO(grid.entryDate)} today={appTodayISO()} />
          ) : null}
          <nav className="mt-2 text-sm">
            <Link
              href="/bonus/employees"
              className="text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
            >
              Manage employees →
            </Link>
          </nav>
        </header>

        <DailyEntryGrid
          rule={grid.rule}
          entryDate={dayISO(grid.entryDate)}
          editable={grid.editable}
          monthState={grid.monthState}
          rows={rows}
        />

        {grid.monthState === 'draft' && (
          <footer className="flex flex-col items-end gap-2 border-t border-dr3-steel-light/25 pt-6">
            <p className="text-right text-sm text-dr3-mist-dim">
              Finished entering counts for {pacificMonthLabel(grid.entryDate)}? Close the month to
              lock entries and start the signature workflow.
            </p>
            <CloseMonthButton
              monthId={grid.monthId}
              monthLabel={pacificMonthLabel(grid.entryDate)}
            />
          </footer>
        )}
      </div>
    </main>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-dr3-mist-dim">
        Bonus management is limited to Woodland managers and administrators.
      </p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
