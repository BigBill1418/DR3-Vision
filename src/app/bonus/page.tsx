// ADR-0019 §4/§7 + ADR-0019.2 §1/§6 — Bonus daily-entry page (T-105 / T-210,
// server component).
//
// MULTI-SITE entry point. Access is the ADR-0019.2 matrix via
// `checkBonusAccess(session, ?site)`:
//   - no session                         → redirect to /login
//   - operator / no bonus access         → in-place forbidden surface
//   - single-site caller (Janette, Rick, Morena) → scope to their one site
//   - multi-site caller (Bill, Kelsey) with NO site picked yet → render the
//     site picker; once picked (?site= or the dr3_bonus_site cookie) → scope to it
//
// The page never trusts middleware alone (CLAUDE.md hard rule #6); every gate is
// re-checked server-side. Site flows through `?site=` (and the picked-site
// cookie) into `requireBonusAccess`, which resolves the effective site id.
//
// Resolves the SEEDED pay period covering the chosen day (via `resolveOpenPayPeriod`
// inside the data layer — T-203 / ADR-0019.1; periods are pre-seeded, never
// fabricated), lists ACTIVE employees alphabetically, and pre-loads today's row.
// The site's processor-bonus rule is resolved server-side and passed to the
// client grid so live bonus math is rule-driven, never hardcoded (CLAUDE.md hard
// rule #3). A day outside every seeded period renders a clean "no open period"
// surface rather than crashing.

import Link from 'next/link';
import { cookies } from 'next/headers';
import { HOME_ROUTE } from '@/lib/routes';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  checkBonusAccess,
  tryBonusAccess,
  parseSiteCode,
  BONUS_SITE_COOKIE,
} from '@/lib/bonus/access';
import { getDailyGrid, NoOpenPayPeriodError } from '@/lib/bonus/daily-entry';
import { appToday, appTodayISO, dayKeyUTCFromISO, dayISO, pacificDateLabel } from '@/lib/time';

/**
 * Compact pay-period date range for the @db.Date window keys (UTC-midnight), e.g.
 * "Jun 9–22, 2026" (same month) or "Dec 30, 2025 – Jan 12, 2026" (spanning). The
 * keys are calendar-day anchors, so they're formatted in UTC to avoid a TZ shift.
 */
function payPeriodRange(start: Date, end: Date): string {
  const md = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  const year = end.getUTCFullYear();
  if (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth()
  ) {
    return `${md(start)}–${end.getUTCDate()}, ${year}`;
  }
  return `${md(start)}, ${start.getUTCFullYear()} – ${md(end)}, ${year}`;
}
import { DailyEntryGrid, type GridRowProps } from './DailyEntryGrid';
import { AdminDatePicker } from './AdminDatePicker';
import { CloseMonthButton } from './CloseMonthButton';
import { SitePicker } from './SitePicker';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ date?: string; site?: string }>;

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
  const sp = await searchParams;
  const requestedSite = parseSiteCode(sp.site);

  // Resolve the caller's full site set first (ADR-0019.2 §1). This drives the
  // single-vs-multi-site branch below.
  const session = await auth();
  const access = await checkBonusAccess(session);
  if (!access.allowed) {
    if (!session?.user?.id) redirect('/login?next=/bonus');
    return <ForbiddenPage />;
  }

  // Multi-site caller (admin) who hasn't pinned a site yet → render the picker.
  // "Pinned" = an explicit ?site= OR the persisted dr3_bonus_site cookie.
  if (access.sites.length > 1 && !requestedSite) {
    const store = await cookies();
    const picked = parseSiteCode(store.get(BONUS_SITE_COOKIE)?.value);
    if (!picked) {
      return <SitePicker sites={access.sites} />;
    }
  }

  // Scope to the effective site (the requested one, else the picked cookie, else
  // the caller's single site). 403 if the caller can't reach the requested site
  // (e.g. Janette asking for ?site=eugene).
  const gate = await tryBonusAccess(requestedSite);
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus');
    return <ForbiddenPage />;
  }

  const entryDate = resolveEntryDate(sp.date, gate.ctx.isAdmin);
  let grid;
  try {
    grid = await getDailyGrid(gate.ctx.siteId, entryDate);
  } catch (e) {
    // No seeded pay period covers the chosen day (ADR-0019.1). Render a clean
    // surface instead of a 500 — this is an out-of-range calendar day.
    if (e instanceof NoOpenPayPeriodError) {
      return <NoOpenPeriodPage date={dayISO(entryDate)} isAdmin={gate.ctx.isAdmin} />;
    }
    throw e;
  }

  const rows: GridRowProps[] = grid.rows.map((r) => ({
    bonus_employee_id: r.bonus_employee_id,
    full_name: r.full_name,
    mattress_count: r.mattress_count,
    note: r.note,
  }));

  // Human label for the bi-weekly pay period (e.g. "Pay Period 13 · Jun 9–22,
  // 2026"). The period is NOT a calendar month — the system migrated to a
  // bi-weekly cadence (ADR-0019.1), so the UI names it as a pay period.
  const periodLabel = `Pay Period ${grid.periodNumber} · ${payPeriodRange(grid.periodStart, grid.periodEnd)}`;

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
          {/* Primary navigation for the bonus area — surfaced as buttons so the
              employee roster and the pay-period history are easy to find from the
              daily-entry screen (operator feedback, 2026-06-09). */}
          <nav className="mt-3 flex flex-wrap gap-3" aria-label="Bonus navigation">
            <Link
              href="/bonus/employees"
              className="inline-flex items-center gap-2 rounded-md border border-dr3-cyan/40 bg-dr3-space-2/60 px-4 py-2 text-sm font-semibold text-dr3-mist transition-colors hover:border-dr3-cyan hover:bg-dr3-space-2"
            >
              <span aria-hidden="true">👥</span> Manage Employees
            </Link>
            <Link
              href="/bonus/months"
              className="inline-flex items-center gap-2 rounded-md border border-dr3-cyan/40 bg-dr3-space-2/60 px-4 py-2 text-sm font-semibold text-dr3-mist transition-colors hover:border-dr3-cyan hover:bg-dr3-space-2"
            >
              <span aria-hidden="true">🗓️</span> Pay Period History
            </Link>
          </nav>
        </header>

        {/* `key` on the entry date forces a remount when the admin picks a
            different business day. Without it, client-side navigation reuses
            the same DailyEntryGrid instance and its `useState` seed (from
            `rows`) never re-runs, so the inputs keep showing the previous
            day's data until a manual reload. Re-keying re-seeds from the new
            day's rows. (fix 2026-06-15) */}
        <DailyEntryGrid
          key={dayISO(grid.entryDate)}
          rule={grid.rule}
          entryDate={dayISO(grid.entryDate)}
          editable={grid.editable}
          monthState={grid.monthState}
          rows={rows}
        />

        {grid.monthState === 'draft' && (
          <footer className="flex flex-col items-end gap-2 border-t border-dr3-steel-light/25 pt-6">
            <p className="text-right text-sm text-dr3-mist-dim">
              Finished entering counts for {periodLabel}? Close the pay period to lock entries and
              start the signature workflow.
            </p>
            <CloseMonthButton monthId={grid.monthId} periodLabel={periodLabel} />
          </footer>
        )}
      </div>
    </main>
  );
}

function NoOpenPeriodPage({ date, isAdmin }: { date: string; isAdmin: boolean }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">No open pay period</h1>
      <p className="mt-2 max-w-md text-dr3-mist-dim">
        There is no bonus pay period that covers {date}. Pay periods are pre-scheduled; pick a date
        inside a scheduled period.
        {isAdmin ? ' Use the date picker on a covered day to backfill entries.' : ''}
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

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-dr3-mist-dim">
        Bonus management is limited to site managers and administrators.
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
