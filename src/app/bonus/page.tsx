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
import { redirect } from 'next/navigation';
import { checkBonusAccess } from '@/lib/bonus/access';
import { getDailyGrid } from '@/lib/bonus/daily-entry';
import { DailyEntryGrid, type GridRowProps } from './DailyEntryGrid';

export const dynamic = 'force-dynamic';

/** Render a Date's UTC calendar day as YYYY-MM-DD (matches the @db.Date key). */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Human heading date, en-US, in UTC so it matches the stored calendar day. */
function headingDate(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export default async function BonusDailyEntryPage() {
  const gate = await checkBonusAccess();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus');
    return <ForbiddenPage />;
  }

  const today = new Date();
  const grid = await getDailyGrid(gate.ctx.siteId, today);

  const rows: GridRowProps[] = grid.rows.map((r) => ({
    bonus_employee_id: r.bonus_employee_id,
    full_name: r.full_name,
    mattress_count: r.mattress_count,
    note: r.note,
  }));

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          >
            ← Back to dashboard
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Daily Bonus Entry</h1>
          <p className="text-sm text-dr3-cream/70">
            {gate.ctx.siteName} processor mattress counts for{' '}
            <span className="font-medium text-dr3-cream">{headingDate(grid.entryDate)}</span>.
            Counts drive each processor&rsquo;s daily bonus; the note is optional and never affects
            the math.
          </p>
          <nav className="mt-2 text-sm">
            <Link
              href="/bonus/employees"
              className="text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
            >
              Manage employees →
            </Link>
          </nav>
        </header>

        <DailyEntryGrid
          rule={grid.rule}
          entryDate={isoDay(grid.entryDate)}
          editable={grid.editable}
          monthState={grid.monthState}
          rows={rows}
        />
      </div>
    </main>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-dr3-cream/70">
        Bonus management is limited to Woodland managers and administrators.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 text-sm text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
