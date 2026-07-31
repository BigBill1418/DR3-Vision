// ADR-0069 Amendment 2 — the TEREX maintenance preview.
//
// This screen IS the "preview" half of preview-then-confirm. Its job is to put
// the money in front of a person before it counts — the total, what was
// de-duplicated, and what could not be dated — so that accepting the batch is a
// decision rather than a formality.
//
// The de-duplication line is the one that matters. The real workbook's
// `Maintenance Log 2025` is a strict subset of `Maintenance Log2026`; both
// total $77,067.94. A reader who does not know that would see two log sheets and
// reasonably expect roughly $154k. Saying what was removed, and why, is what
// makes the smaller number believable.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { TerexReviewClient } from './TerexReviewClient';

export const dynamic = 'force-dynamic';

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function TerexPreviewPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">Maintenance cost data is restricted to administrators.</p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const rows = await prisma.docTerexMaintenanceRow.findMany({
    where: { status: { in: ['staged', 'confirmed'] } },
    orderBy: [{ status: 'asc' }, { event_date: 'desc' }, { row_index: 'asc' }],
    select: {
      id: true,
      doc_source_version_id: true,
      sheet_name: true,
      row_index: true,
      event_date: true,
      event_date_raw: true,
      issue: true,
      measures_taken: true,
      notes: true,
      estimated_cost: true,
      actual_repair_cost: true,
      amount_credited: true,
      status: true,
      confirmed_at: true,
    },
  });

  const stagedRows = rows.filter((r) => r.status === 'staged');
  const confirmedRows = rows.filter((r) => r.status === 'confirmed');
  const stagedVersionId = stagedRows[0]?.doc_source_version_id ?? null;

  const total = (rs: typeof rows, pick: (r: (typeof rows)[number]) => unknown): number =>
    rs.reduce((a, r) => a + Number(pick(r) ?? 0), 0);

  const stagedActual = total(stagedRows, (r) => r.actual_repair_cost);
  const stagedCredited = total(stagedRows, (r) => r.amount_credited);
  const confirmedActual = total(confirmedRows, (r) => r.actual_repair_cost);
  const undated = stagedRows.filter((r) => r.event_date === null).length;
  const sheets = [...new Set(stagedRows.map((r) => r.sheet_name))];

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/admin/doc-ingest"
          className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
        >
          ← Document ingestion
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">TEREX maintenance</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          Maintenance events extracted from the shared TEREX workbook. This document carries
          <strong> money</strong>, so rows are <strong>staged</strong> and count only once you
          confirm them (ADR-0069 Am.2). Reference data — it feeds no invoice, payable or billing
          figure.
        </p>

        {rows.length === 0 ? (
          <p className="mt-8 rounded-lg bg-dr3-steel/20 p-6 text-sm text-dr3-mist-dim">
            Nothing extracted yet. The TEREX workbook absorbs once its class and site are confirmed
            on the{' '}
            <Link href="/admin/doc-ingest" className="text-dr3-cyan underline">
              confirm queue
            </Link>
            .
          </p>
        ) : (
          <>
            {stagedRows.length > 0 && stagedVersionId && (
              <section className="mt-6 rounded-lg bg-amber-500/10 p-5 ring-1 ring-amber-500/30">
                <h2 className="text-lg font-semibold text-amber-200">
                  {stagedRows.length} event{stagedRows.length === 1 ? '' : 's'} waiting for you
                </h2>

                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Actual repair cost" value={usd(stagedActual)} tone="warn" />
                  <Stat label="Amount credited" value={usd(stagedCredited)} />
                  <Stat label="Events" value={String(stagedRows.length)} />
                  <Stat
                    label="No usable date"
                    value={String(undated)}
                    hint="kept, shown as written"
                  />
                </div>

                <p className="mt-4 text-sm leading-relaxed text-amber-100/90">
                  Read from{' '}
                  <strong>{sheets.map((s) => `“${s}”`).join(' and ') || '(no sheet)'}</strong>. The
                  workbook has two maintenance-log sheets that overlap almost completely — the older
                  one is a stale copy of the newer. Duplicate events were removed, so this total is{' '}
                  <strong>the real spend, not twice it</strong>. Its 28 monthly operating tabs and
                  its OVERVIEW/summary tabs were deliberately left alone: the summaries are derived
                  from the monthly ones, and the monthly ones carry processed units that
                  workbook-sync owns.
                </p>

                <TerexReviewClient versionId={stagedVersionId} count={stagedRows.length} />
              </section>
            )}

            {confirmedRows.length > 0 && (
              <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
                <Stat label="Confirmed events" value={String(confirmedRows.length)} tone="ok" />
                <Stat label="Confirmed repair cost" value={usd(confirmedActual)} tone="ok" />
              </div>
            )}

            <div className="mt-6 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Issue</th>
                    <th className="px-3 py-2">Measures taken</th>
                    <th className="px-3 py-2 text-right">Repair cost</th>
                    <th className="px-3 py-2 text-right">Credited</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2 text-right">Sheet · row</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t border-dr3-steel-light/15 align-top"
                      data-testid="terex-row"
                    >
                      <td className="px-3 py-2 tabular-nums">
                        {r.event_date ? (
                          r.event_date.toISOString().slice(0, 10)
                        ) : (
                          <span
                            className="text-amber-300"
                            title="the sheet's date could not be read as a date; shown as written"
                          >
                            {r.event_date_raw ?? '—'}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[26ch] px-3 py-2">{r.issue ?? '—'}</td>
                      <td className="max-w-[30ch] px-3 py-2 text-dr3-mist-dim">
                        {r.measures_taken ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.actual_repair_cost === null ? (
                          <span className="text-dr3-mist-dim/60">not recorded</span>
                        ) : (
                          usd(Number(r.actual_repair_cost))
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                        {r.amount_credited === null ? '—' : usd(Number(r.amount_credited))}
                      </td>
                      <td className="px-3 py-2">
                        {r.status === 'staged' ? (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300 ring-1 ring-amber-500/30">
                            staged
                          </span>
                        ) : (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                            confirmed
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-dr3-mist-dim/60">
                        {r.sheet_name} · {r.row_index}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs text-dr3-mist-dim">
              A repair with no cost in the sheet shows as “not recorded”, never $0 — a repair nobody
              priced is not a free repair. A date the sheet did not record as a date (the file
              contains “09/16 or 17”, “Jan”, and one Excel epoch artefact) is shown exactly as
              written rather than guessed into a day.
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
  tone?: 'ok' | 'warn';
}) {
  const cls =
    tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-dr3-mist';
  return (
    <div className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20">
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-dr3-mist-dim/70">{hint}</div>}
    </div>
  );
}
