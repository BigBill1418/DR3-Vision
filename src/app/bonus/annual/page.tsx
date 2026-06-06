// ADR-0019 §8 — Annual aggregate page (T-118, server component).
//
// Gated via `checkBonusAccess()` (Woodland-scoped): 401 → redirect to /login,
// 403 → render the forbidden surface in-place (Rick / operators land here). The
// page never trusts middleware alone (CLAUDE.md hard rule #6).
//
// Per-employee year-to-date totals for a selectable year (?year=YYYY, default
// current UTC year). Each employee links to their cross-month detail page. A CSV
// export button hits GET /api/bonus/annual/export (same gate) for the displayed
// year. Names follow ADR-0019 §9b: current name + a "previously known as" badge.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkBonusAccess } from '@/lib/bonus/access';
import { annualTotals, type AnnualEmployeeRow } from '@/lib/bonus/aggregates';
import { formatCents } from '@/lib/bonus/calculator';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ year?: string }>;

/** Parse ?year= to a sane 4-digit year; default to the current UTC year. */
function parseYear(raw: string | undefined): number {
  const now = new Date().getUTCFullYear();
  if (!raw) return now;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2000 || n > now + 1) return now;
  return n;
}

export default async function BonusAnnualPage({ searchParams }: { searchParams: SearchParams }) {
  const gate = await checkBonusAccess();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus/annual');
    return <ForbiddenPage />;
  }

  const sp = await searchParams;
  const year = parseYear(sp.year);
  const rows = await annualTotals(gate.ctx.siteId, year);

  const grandTotalCents = rows.reduce((s, r) => s + r.bonusCents, 0);
  const totalMattresses = rows.reduce((s, r) => s + r.mattresses, 0);
  const currentYear = new Date().getUTCFullYear();
  // Offer the last 5 years plus next year (for an early-January boundary).
  const yearOptions: number[] = [];
  for (let y = currentYear + 1; y >= currentYear - 4; y--) yearOptions.push(y);

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/bonus"
            className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          >
            ← Back to daily entry
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Annual Bonus Aggregate</h1>
          <p className="text-sm text-dr3-cream/70">
            {gate.ctx.siteName} per-processor totals for the calendar year. Each month uses the
            bonus rule effective that month; figures match the daily grid and the signed PDF.
          </p>
        </header>

        <div className="flex flex-wrap items-end justify-between gap-4">
          {/* Year selector — plain GET form, no client JS needed. */}
          <form method="GET" className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-dr3-cream/70">Year</span>
              <select
                name="year"
                defaultValue={String(year)}
                className="rounded border border-dr3-cream/20 bg-dr3-green-dark/60 px-3 py-2 text-dr3-cream"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded bg-dr3-green-dark px-4 py-2 text-sm font-medium text-dr3-cream hover:bg-dr3-green-dark/80"
            >
              View
            </button>
          </form>

          <a
            href={`/api/bonus/annual/export?year=${year}`}
            className="rounded bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink hover:bg-dr3-chartreuse/90"
          >
            Export CSV
          </a>
        </div>

        {/* Year summary */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryCard label={`${year} total bonus`} value={formatCents(grandTotalCents)} />
          <SummaryCard label="Total mattresses" value={String(totalMattresses)} />
          <SummaryCard label="Processors" value={String(rows.length)} />
        </section>

        {rows.length === 0 ? (
          <p className="text-sm text-dr3-cream/60">No bonus entries recorded for {year}.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-dr3-cream/15">
            <table className="w-full text-left text-sm">
              <thead className="bg-dr3-green-dark/60 text-dr3-cream/80">
                <tr>
                  <th className="px-4 py-2 font-medium">Processor</th>
                  <th className="px-4 py-2 text-right font-medium">Mattresses</th>
                  <th className="px-4 py-2 text-right font-medium">Days qualified</th>
                  <th className="px-4 py-2 text-right font-medium">Bonus</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <AnnualRow key={r.employeeId} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-dr3-cream/15 bg-dr3-green-dark/40 px-5 py-4">
      <p className="text-xs uppercase tracking-wide text-dr3-cream/60">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function AnnualRow({ r }: { r: AnnualEmployeeRow }) {
  return (
    <tr className="border-t border-dr3-cream/10">
      <td className="px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/bonus/employee/${r.employeeId}`}
            className="font-medium text-dr3-cream underline-offset-4 hover:underline"
          >
            {r.name}
          </Link>
          {r.previousNames.length > 0 && (
            <span
              className="rounded-full bg-dr3-chartreuse/20 px-2 py-0.5 text-xs font-medium text-dr3-chartreuse"
              title={r.previousNames.map((p) => p.name).join(', ')}
            >
              previously known as {r.previousNames.map((p) => p.name).join(', ')}
            </span>
          )}
          {!r.isActive && (
            <span className="rounded-full bg-dr3-cream/15 px-2 py-0.5 text-xs font-medium text-dr3-cream/70">
              inactive
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-2 text-right tabular-nums">{r.mattresses}</td>
      <td className="px-4 py-2 text-right tabular-nums">{r.daysQualified}</td>
      <td className="px-4 py-2 text-right font-medium tabular-nums">{formatCents(r.bonusCents)}</td>
      <td className="px-4 py-2 text-right">
        <Link
          href={`/bonus/employee/${r.employeeId}`}
          className="text-dr3-chartreuse underline-offset-4 hover:underline"
        >
          History →
        </Link>
      </td>
    </tr>
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
