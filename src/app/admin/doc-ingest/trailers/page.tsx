// ADR-0069 Amendment 1 — the absorbed trailer list, as queryable Vision data.
//
// This screen is what closes the absorption audit's core finding: "no parsed
// value reaches a queryable table, report, dashboard, or comparison." These rows
// came out of a shared spreadsheet's cells and are now real columns.
//
// ── Reference data, and it says so ──────────────────────────────────────────
// Nothing here is load-bearing. It does not feed billing, payroll, inventory or
// the COR. The single-writer rule is intact: the absorption bridge writes
// `doc_trailer_rows` and nothing else, and no operational read depends on it.
//
// ── It shows what the sheet SAID, not a tidied version ──────────────────────
// Material is free text and genuinely inconsistent in the real file ("pocket
// coil" / "Pocketcoil", and origins like "Recology SF" used in the material
// column). It is displayed verbatim. A weight the sheet did not record shows as
// "not recorded" — never 0 — because 19 of the live file's 96 rows have no
// weight and zeroing them would invent nineteen empty trailers.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

function day(d: Date | null): string {
  if (!d) return '—';
  return d.toISOString().slice(0, 10);
}

export default async function AbsorbedTrailersPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  // The newest absorbed generation per source. Rows are keyed to the version they
  // came from, so a re-ingest appends rather than mutates and the previous
  // generation stays readable — this picks the current one.
  const newest = await prisma.docTrailerRow.findFirst({
    orderBy: { absorbed_at: 'desc' },
    select: { doc_source_version_id: true, absorbed_at: true },
  });

  const rows = newest
    ? await prisma.docTrailerRow.findMany({
        where: { doc_source_version_id: newest.doc_source_version_id },
        orderBy: [{ entry_date: 'desc' }, { row_index: 'asc' }],
        select: {
          id: true,
          sheet_name: true,
          row_index: true,
          entry_date: true,
          trailer_no: true,
          material_raw: true,
          weight_lbs: true,
          weight_raw: true,
          driver: true,
          days_in_yard_sheet: true,
          exit_date: true,
          exit_raw: true,
          notes: true,
          site: { select: { name: true } },
        },
      })
    : [];

  const withWeight = rows.filter((r) => r.weight_lbs !== null);
  const totalWeight = withWeight.reduce((a, r) => a + Number(r.weight_lbs), 0);
  const open = rows.filter((r) => r.exit_date === null);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/admin/doc-ingest"
          className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
        >
          ← Document ingestion
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Trailer list — absorbed</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          Rows extracted from the shared trailer workbook into a real Vision table (ADR-0069 Am.1).
          This is <strong>reference data</strong> — it feeds no billing, payroll, inventory or COR
          figure. Values are shown exactly as the sheet recorded them.
        </p>

        {rows.length === 0 ? (
          <p className="mt-8 rounded-lg bg-dr3-steel/20 p-6 text-sm text-dr3-mist-dim">
            Nothing absorbed yet. A trailer workbook absorbs once its class and site are confirmed
            on the{' '}
            <Link href="/admin/doc-ingest" className="text-dr3-cyan underline">
              confirm queue
            </Link>
            .
          </p>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Trailer rows" value={String(rows.length)} />
              <Stat label="Still in the yard" value={String(open.length)} />
              <Stat
                label="Total weight (lbs)"
                value={totalWeight.toLocaleString()}
                hint={`from ${withWeight.length} of ${rows.length} rows`}
              />
              <Stat
                label="No weight recorded"
                value={String(rows.length - withWeight.length)}
                hint="blank or “-” in the sheet"
              />
            </div>

            <p className="mt-3 text-xs text-dr3-mist-dim">
              Absorbed{' '}
              {newest ? newest.absorbed_at.toISOString().replace('T', ' ').slice(0, 16) : ''} UTC ·
              sheet “{rows[0]?.sheet_name}” · {rows[0]?.site?.name ?? 'unscoped'}
            </p>

            <div className="mt-6 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
                  <tr>
                    <th className="px-3 py-2">Entered</th>
                    <th className="px-3 py-2">Trailer #</th>
                    <th className="px-3 py-2">Material (as written)</th>
                    <th className="px-3 py-2 text-right">Weight (lbs)</th>
                    <th className="px-3 py-2">Driver</th>
                    <th className="px-3 py-2 text-right">Days in yard</th>
                    <th className="px-3 py-2">Exit</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2 text-right">Row</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t border-dr3-steel-light/15"
                      data-testid="trailer-row"
                    >
                      <td className="px-3 py-2 tabular-nums">{day(r.entry_date)}</td>
                      <td className="px-3 py-2 font-medium tabular-nums">{r.trailer_no}</td>
                      <td className="max-w-[26ch] px-3 py-2 text-dr3-mist-dim">
                        {r.material_raw ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.weight_lbs === null ? (
                          <span
                            className="text-dr3-mist-dim/60"
                            title={`the sheet recorded ${r.weight_raw ?? 'nothing'}`}
                          >
                            not recorded
                          </span>
                        ) : (
                          Number(r.weight_lbs).toLocaleString()
                        )}
                      </td>
                      <td className="px-3 py-2 text-dr3-mist-dim">{r.driver ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                        {r.days_in_yard_sheet ?? '—'}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {r.exit_date ? (
                          day(r.exit_date)
                        ) : r.exit_raw ? (
                          <span className="text-amber-300" title="not a date in the sheet">
                            {r.exit_raw}
                          </span>
                        ) : (
                          <span className="text-emerald-300">in yard</span>
                        )}
                      </td>
                      <td className="max-w-[22ch] px-3 py-2 text-xs text-dr3-mist-dim">
                        {r.notes ?? ''}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-dr3-mist-dim/60">
                        {r.row_index}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs text-dr3-mist-dim">
              “Days in yard” is the spreadsheet’s own formula result, stored as-is and never
              recomputed — showing a number the sheet does not show is how two systems start
              disagreeing about a figure neither owns. “Row” is the source row in the sheet.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20">
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-dr3-mist">{value}</div>
      {hint && <div className="mt-1 text-xs text-dr3-mist-dim/70">{hint}</div>}
    </div>
  );
}
