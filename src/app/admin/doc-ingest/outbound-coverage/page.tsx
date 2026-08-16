// ADR-0104 §D10 — outbound weight coverage. READ-ONLY.
//
// This page answers one question: of the outbound loads MyMRC says shipped, how
// many does Vision now know the weight of?
//
// It states no verdict. There is no threshold, no tolerance, no "ok"/"mismatch"
// badge and no alert on this screen, and that is deliberate — grading a
// disagreement is AK-4c, Bill's call with Rick and Janette (P-48). A number with
// a colour is a judgement, so the numbers here have no colour beyond "covered"
// and "not covered".
//
// The headline it will show is a BAD one: the workbook covers Woodland,
// January to June 2026, and the mirror holds 4,673 loads back to 2023. Most
// loads still have no weight. Saying so is the point (P-47) — the alternative
// is today's silence, which reads as health.
//
// Every figure names the ONE revision it came from. See `outbound-reconcile.ts`
// for why that is not optional.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  computeOutboundCoverage,
  sitesWithOutboundCoverage,
  UNDATED_BUCKET,
  type OutboundScope,
} from '@/lib/doc-ingest/outbound-reconcile';

export const dynamic = 'force-dynamic';

function lbs(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} lb`;
}

/** Pacific wall clock, never UTC — matches every DR3 surface. */
function pt(iso: string | null): string {
  if (!iso) return '—';
  return `${new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  })} PT`;
}

function monthLabel(month: string): string {
  if (month === UNDATED_BUCKET) return 'No shipment date';
  const [y, m] = month.split('-');
  if (!y || !m) return month;
  return `${new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
  })}`;
}

export default async function OutboundCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; scope?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">Outbound weight data is restricted to administrators.</p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const params = await searchParams;
  const sites = await sitesWithOutboundCoverage();
  const siteId = params.site ?? sites[0]?.id ?? null;
  // Only the two real states, never a union of them — see `OutboundScope`.
  const scope: OutboundScope = params.scope === 'staged' ? 'staged' : 'confirmed';
  const coverage = siteId === null ? null : await computeOutboundCoverage(siteId, { scope });
  const siteName = sites.find((s) => s.id === siteId)?.name ?? null;

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/admin/doc-ingest"
          className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
        >
          ← Document ingestion
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Outbound weight coverage</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          <strong>Read-only.</strong> Of the outbound loads MyMRC records, how many does Vision now
          have a weight for. This screen states <strong>no verdict</strong>: there is no threshold,
          no tolerance and no pass/fail on it. What a disagreement between the two records{' '}
          <em>means</em> is a decision for Bill with Rick and Janette (ADR-0104 §D10 · P-48), and a
          rule guessed here would become the default by being first.
        </p>

        {sites.length > 1 || (coverage && !coverage.awaiting) ? (
          <nav className="mt-4 flex flex-wrap gap-2 text-xs">
            {sites.map((s) => (
              <Link
                key={s.id}
                href={`/admin/doc-ingest/outbound-coverage?site=${s.id}&scope=${scope}`}
                className={`rounded px-3 py-1 ring-1 ${
                  s.id === siteId
                    ? 'bg-dr3-cyan/20 text-dr3-cyan ring-dr3-cyan/40'
                    : 'text-dr3-mist-dim ring-dr3-steel-light/25'
                }`}
              >
                {s.name}
              </Link>
            ))}
            {siteId
              ? (['confirmed', 'staged'] as const).map((sc) => (
                  <Link
                    key={sc}
                    href={`/admin/doc-ingest/outbound-coverage?site=${siteId}&scope=${sc}`}
                    className={`rounded px-3 py-1 ring-1 ${
                      sc === scope
                        ? 'bg-dr3-cyan/20 text-dr3-cyan ring-dr3-cyan/40'
                        : 'text-dr3-mist-dim ring-dr3-steel-light/25'
                    }`}
                  >
                    {sc}
                  </Link>
                ))
              : null}
          </nav>
        ) : null}

        {coverage === null || coverage.awaiting ? (
          <p className="mt-8 rounded-lg bg-dr3-steel/20 p-6 text-sm text-dr3-mist-dim">
            No <strong>{scope}</strong> outbound rows
            {siteName ? ` for ${siteName}` : ''} yet. Weights are staged when the workbook absorbs
            and become <em>confirmed</em> only after somebody accepts the batch on the{' '}
            <Link href="/admin/doc-ingest/outbound" className="text-dr3-cyan underline">
              outbound weights
            </Link>{' '}
            screen.
          </p>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Loads on record (MyMRC)" value={String(coverage.totals.mirrorLoads)} />
              <Stat
                label="With a weight"
                value={String(coverage.totals.loadsWithWeight)}
                tone="ok"
              />
              <Stat
                label="Still without one"
                value={String(coverage.totals.loadsWithoutWeight)}
                hint="no watched document supplies these"
              />
              <Stat label="Weight known" value={lbs(coverage.totals.weightLbs)} />
            </div>

            <p className="mt-4 rounded-lg bg-dr3-steel/20 p-4 text-xs text-dr3-mist-dim">
              Every figure on this page comes from <strong>one revision</strong> of the workbook —{' '}
              <code className="text-dr3-mist">{coverage.versionId}</code>, absorbed{' '}
              {pt(coverage.absorbedAtISO)}, at <strong>{coverage.scope}</strong> scope. Revisions are
              not summed together: each one is a complete copy of the document, so adding two would
              report twice the tonnage while looking like a bigger, better answer.
              {coverage.unmatchedAbsorbedLoads.length > 0 ? (
                <>
                  {' '}
                  <strong className="text-amber-300">
                    {coverage.unmatchedAbsorbedLoads.length} absorbed load(s) have no matching MyMRC
                    record
                  </strong>{' '}
                  ({coverage.unmatchedAbsorbedLoads.slice(0, 8).join(', ')}) — a weight for a
                  shipment the system has no other trace of.
                </>
              ) : (
                <> Every absorbed load matches a MyMRC record.</>
              )}
            </p>

            <div className="mt-6 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
                  <tr>
                    <th className="px-3 py-2">Month shipped</th>
                    <th className="px-3 py-2 text-right">Loads (MyMRC)</th>
                    <th className="px-3 py-2 text-right">With a weight</th>
                    <th className="px-3 py-2 text-right">Without</th>
                    <th className="px-3 py-2 text-right">Weight known</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.months.map((m) => (
                    <tr
                      key={m.month}
                      className="border-t border-dr3-steel-light/15"
                      data-testid="coverage-month"
                    >
                      <td className="px-3 py-2">{monthLabel(m.month)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.mirrorLoads}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-300">
                        {m.loadsWithWeight}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                        {m.loadsWithoutWeight}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {m.weightLbs === 0 ? '—' : lbs(m.weightLbs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {coverage.commodities.length > 0 && (
              <>
                <h2 className="mt-8 text-lg font-semibold">By commodity</h2>
                <p className="mt-1 text-xs text-dr3-mist-dim">
                  Commodity names and dispositions are stored exactly as the workbook writes them.
                  Nothing here is mapped onto a recycled/landfilled classification — that mapping is
                  an operational claim this pipeline does not make.
                </p>
                <div className="mt-3 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
                      <tr>
                        <th className="px-3 py-2">Commodity</th>
                        <th className="px-3 py-2 text-right">Rows</th>
                        <th className="px-3 py-2 text-right">Weight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coverage.commodities.map((c) => (
                        <tr key={c.commodity} className="border-t border-dr3-steel-light/15">
                          <td className="px-3 py-2">{c.commodity}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                            {c.rows}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{lbs(c.weightLbs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <p className="mt-6 text-xs text-dr3-mist-dim">
              The uncovered count is expected to be large, and it is shown rather than hidden. The
              only document that supplies outbound weights covers <strong>Woodland</strong>,{' '}
              <strong>January to June 2026</strong>. Loads before 2026, after June 2026, and every
              Eugene load remain weightless, and no currently watched document supplies them
              (ADR-0104 · P-47). A load whose own weight cell was blank counts as{' '}
              <em>without a weight</em>, not as covered.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'ok';
}) {
  return (
    <div className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20">
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div
        className={`mt-1 text-2xl font-bold tabular-nums ${tone === 'ok' ? 'text-emerald-300' : 'text-dr3-mist'}`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-dr3-mist-dim/70">{hint}</div>}
    </div>
  );
}
