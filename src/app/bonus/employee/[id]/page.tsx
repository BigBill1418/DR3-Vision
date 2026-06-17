// ADR-0019 §8 — Per-employee cross-month history page (T-118, server component).
//
// Gated via `checkBonusAccess()` (Woodland-scoped): 401 → redirect to /login,
// 403 → render the forbidden surface in-place (Rick / operators land here). The
// page never trusts middleware alone (CLAUDE.md hard rule #6).
//
// Shows one employee's monthly totals (newest first), year-to-date totals, and a
// plain HTML/Tailwind last-12-months bar list (no chart lib). Per ADR-0019 §9b
// the CURRENT name is the heading; a "previously known as" badge appears when the
// employee has prior names. Each month row links to that month's detail page.

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import { notFound, redirect } from 'next/navigation';
import { tryBonusAccess, parseSiteCode } from '@/lib/bonus/access';
import { employeeHistory, type EmployeeMonthTotal } from '@/lib/bonus/aggregates';
import {
  currentPeriodForEmployee,
  type CurrentPeriodForEmployee,
} from '@/lib/bonus/current-period';
import { formatCents } from '@/lib/bonus/calculator';

export const dynamic = 'force-dynamic';

export default async function BonusEmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ site?: string }>;
}) {
  const sp = await searchParams;
  const gate = await tryBonusAccess(parseSiteCode(sp.site));
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus/annual');
    return <ForbiddenPage />;
  }

  const { id } = await params;
  const history = await employeeHistory(gate.ctx.siteId, id, { months: 24 });
  if (!history) notFound();

  const current = await currentPeriodForEmployee(gate.ctx.siteId, id);

  const maxBonus = Math.max(1, ...history.last12.map((m) => m.bonusCents));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/bonus/annual"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
          >
            ← Back to annual aggregate
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{history.name}</h1>
            {history.previousNames.length > 0 && (
              <span
                className="rounded-full bg-dr3-cyan/15 px-3 py-1 text-xs font-medium text-dr3-cyan"
                title={history.previousNames.map((p) => p.name).join(', ')}
              >
                previously known as {history.previousNames.map((p) => p.name).join(', ')}
              </span>
            )}
            {!history.isActive && (
              <span className="rounded-full bg-dr3-steel-light/25 px-3 py-1 text-xs font-medium text-dr3-mist-dim">
                inactive
              </span>
            )}
          </div>
          <p className="text-sm text-dr3-mist-dim">
            {gate.ctx.siteName} processor bonus history. Each month uses the bonus rule effective
            that month; figures match the daily grid and the signed PDF.
          </p>
        </header>

        {/* Current pay period — live, in-progress standing (ADR-0031). */}
        <CurrentPeriodBanner current={current} />

        {/* Year-to-date summary */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryCard label={`Year-to-date bonus`} value={formatCents(history.ytd.bonusCents)} />
          <SummaryCard label="Mattresses (YTD)" value={String(history.ytd.mattresses)} />
          <SummaryCard label="Days qualified (YTD)" value={String(history.ytd.daysQualified)} />
        </section>

        {/* Last-12-months bar list (plain HTML/Tailwind, no chart lib). */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Last 12 months</h2>
          {history.last12.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">No bonus months recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {history.last12.map((m) => (
                <li key={m.monthId} className="flex items-center gap-3 text-sm">
                  <span className="w-28 shrink-0 text-dr3-mist-dim">{m.label}</span>
                  <span className="relative h-5 flex-1 overflow-hidden rounded bg-dr3-space-2">
                    <span
                      className="absolute inset-y-0 left-0 rounded bg-dr3-cyan"
                      style={{ width: `${Math.round((m.bonusCents / maxBonus) * 100)}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right font-medium tabular-nums">
                    {formatCents(m.bonusCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Per-month table, newest first, each row drills into the month. */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Monthly totals</h2>
          {history.months.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">This processor has no keyed months yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-dr3-steel-light/25">
              <table className="w-full text-left text-sm">
                <thead className="bg-dr3-space-2/80 text-dr3-cyan">
                  <tr>
                    <th className="px-4 py-2 font-medium">Month</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Mattresses</th>
                    <th className="px-4 py-2 text-right font-medium">Days qualified</th>
                    <th className="px-4 py-2 text-right font-medium">Bonus</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {history.months.map((m) => (
                    <MonthRow key={m.monthId} m={m} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function CurrentPeriodBanner({ current }: { current: CurrentPeriodForEmployee }) {
  const { period, thresholdLow, standing } = current;
  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-dr3-cyan/40 bg-dr3-space-2/60 px-5 py-4"
      data-testid="employee-current-period"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold">Current pay period</h2>
        {period ? (
          <>
            <span className="text-sm text-dr3-mist-dim">{period.label}</span>
            <span className="rounded-full bg-dr3-cyan/15 px-2 py-0.5 text-xs font-medium text-dr3-cyan">
              in progress
            </span>
          </>
        ) : (
          <span className="text-sm text-dr3-mist-dim">no open period covers today</span>
        )}
      </div>

      {period && standing ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="Units so far" value={String(standing.units)} />
          <Metric label="Days qualified" value={String(standing.daysQualified)} />
          <Metric
            label="Days short"
            value={String(standing.daysShort)}
            accent={standing.daysShort > 0}
          />
          <Metric label="Bonus accrued" value={formatCents(standing.bonusCents)} />
        </div>
      ) : (
        <p className="text-sm text-dr3-mist-dim">
          No keyed days this period yet.
          {thresholdLow != null ? ` Qualifies above ${thresholdLow} units/day.` : ''}
        </p>
      )}

      {period && standing && thresholdLow != null ? (
        <p className="text-xs text-dr3-mist-dim">
          Qualifies above {thresholdLow} units/day; figures match the daily grid and the signed PDF.
        </p>
      ) : null}
    </section>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${accent ? 'text-amber-300' : 'text-dr3-mist'}`}
      >
        {value}
      </p>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2/70 px-5 py-4">
      <p className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-dr3-mist">{value}</p>
    </div>
  );
}

function MonthRow({ m }: { m: EmployeeMonthTotal }) {
  return (
    <tr className="border-t border-dr3-steel-light/20 odd:bg-dr3-space-2/40">
      <td className="px-4 py-2 font-medium text-dr3-mist">{m.label}</td>
      <td className="px-4 py-2 text-dr3-mist-dim">{m.state}</td>
      <td className="px-4 py-2 text-right tabular-nums">{m.mattresses}</td>
      <td className="px-4 py-2 text-right tabular-nums">{m.daysQualified}</td>
      <td className="px-4 py-2 text-right font-medium tabular-nums">{formatCents(m.bonusCents)}</td>
      <td className="px-4 py-2 text-right">
        <Link
          href={`/bonus/months/${m.monthId}`}
          className="text-dr3-cyan underline-offset-4 hover:text-dr3-cyan-bright hover:underline"
        >
          View →
        </Link>
      </td>
    </tr>
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
