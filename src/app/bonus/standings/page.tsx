// ADR-0031 — Current pay-period standings (live, in-progress report).
//
// Gated via `tryBonusAccess` (site-scoped): 401 → redirect to /login, 403 →
// render the forbidden surface in-place (operators land here). The page never
// trusts middleware alone (CLAUDE.md hard rule #6). `force-dynamic` so every
// load reflects the latest keyed entries — this is the "where is everyone right
// now" view, not a cached report.
//
// Each row drills into that processor's detail page (`/bonus/employee/[id]`),
// which leads with the same open-period banner and then the cross-period
// history. The roster MANAGER (add/rename/deactivate) lives at
// `/bonus/employees`, reachable from the /bonus landing — this page is read-only
// standings, not management.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { tryBonusAccess, parseSiteCode } from '@/lib/bonus/access';
import { currentPeriodStandings, type CurrentPeriodStanding } from '@/lib/bonus/current-period';
import { formatCents } from '@/lib/bonus/calculator';

export const dynamic = 'force-dynamic';

export default async function BonusStandingsPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>;
}) {
  const sp = await searchParams;
  const gate = await tryBonusAccess(parseSiteCode(sp.site));
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus/standings');
    return <ForbiddenPage />;
  }

  const { period, thresholdLow, rows } = await currentPeriodStandings(gate.ctx.siteId);
  const siteQuery = sp.site ? `?site=${encodeURIComponent(sp.site)}` : '';

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">Current pay period — live standings</h1>
          {period ? (
            <p className="text-sm text-dr3-mist-dim">
              {gate.ctx.siteName} ·{' '}
              <span className="font-medium text-dr3-mist">{period.label}</span>{' '}
              <span className="rounded-full bg-dr3-cyan/15 px-2 py-0.5 text-xs font-medium text-dr3-cyan">
                in progress
              </span>
              {thresholdLow != null ? (
                <>
                  {' '}
                  · qualifies above{' '}
                  <span className="font-medium text-dr3-mist">{thresholdLow}</span> units/day
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-sm text-dr3-mist-dim">
              {gate.ctx.siteName} · no open pay period covers today. Figures will populate when the
              next period opens.
            </p>
          )}
          <p className="text-xs text-dr3-mist-dim">
            Live period-to-date figures. They match the daily grid and the signed PDF the period
            will produce at close. Tap a processor for their full cross-period history.
          </p>
        </header>

        <section className="overflow-x-auto rounded-lg border border-dr3-steel-light/25">
          <table className="w-full text-left text-sm">
            <thead className="bg-dr3-space-2/80 text-dr3-cyan">
              <tr>
                <th className="px-4 py-2 font-medium">Processor</th>
                <th className="px-4 py-2 text-right font-medium">Units so far</th>
                <th className="px-4 py-2 text-right font-medium">Days qualified</th>
                <th className="px-4 py-2 text-right font-medium">Days short</th>
                <th className="px-4 py-2 text-right font-medium">Bonus accrued</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-dr3-mist-dim" colSpan={6}>
                    No active processors on the {gate.ctx.siteName} roster.
                  </td>
                </tr>
              ) : (
                rows.map((r) => <StandingRow key={r.employeeId} r={r} siteQuery={siteQuery} />)
              )}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}

function StandingRow({ r, siteQuery }: { r: CurrentPeriodStanding; siteQuery: string }) {
  return (
    <tr className="border-t border-dr3-steel-light/20 odd:bg-dr3-space-2/40">
      <td className="px-4 py-2">
        <div className="flex flex-col">
          <span className="font-medium text-dr3-mist">{r.name}</span>
          {r.employeeNumber ? (
            <span className="text-xs text-dr3-mist-dim">
              Employee #: <span className="font-mono">{r.employeeNumber}</span>
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-2 text-right tabular-nums">{r.units}</td>
      <td className="px-4 py-2 text-right tabular-nums">{r.daysQualified}</td>
      <td
        className={`px-4 py-2 text-right tabular-nums ${
          r.daysShort > 0 ? 'text-amber-300' : 'text-dr3-mist-dim'
        }`}
      >
        {r.daysShort}
      </td>
      <td className="px-4 py-2 text-right font-medium tabular-nums">{formatCents(r.bonusCents)}</td>
      <td className="px-4 py-2 text-right">
        <Link
          href={`/bonus/employee/${r.employeeId}${siteQuery}`}
          className="text-dr3-cyan underline-offset-4 hover:text-dr3-cyan-bright hover:underline"
        >
          History →
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
        Bonus reporting is limited to site managers and administrators.
      </p>
    </main>
  );
}
