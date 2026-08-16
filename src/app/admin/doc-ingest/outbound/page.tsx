// ADR-0104 §D2/§D5 — the outbound weight-audit preview.
//
// This screen IS the "preview" half of preview-then-confirm, and its job is to
// make the SMALLER number believable. A reader who opens the workbook sees
// eleven sheets of outbound loads and would reasonably expect roughly 1,387
// rows. This page shows 831 and says, in the same breath, that 556 of those rows
// were the same shipment appearing on a second sheet — four sheet pairs that are
// exact copies of one another, plus one filtered subset sheet.
//
// It also states the sign check. `Total Outbound Materials Weight` is the
// NEGATION of the real per-load figure, and an extractor that reached for that
// right-most, most official-sounding column would produce a total that is
// internally consistent and wrong. Saying which column was used is what makes
// the figure auditable rather than merely printed.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { StagedBatchReviewClient } from '../StagedBatchReviewClient';

export const dynamic = 'force-dynamic';

function lbs(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} lb`;
}

export default async function OutboundPreviewPage() {
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

  const rows = await prisma.docOutboundLoadRow.findMany({
    where: { status: { in: ['staged', 'confirmed'] } },
    orderBy: [{ status: 'asc' }, { shipment_date: 'desc' }, { external_materials_id: 'asc' }],
    select: {
      id: true,
      doc_source_version_id: true,
      sheet_name: true,
      row_index: true,
      external_materials_id: true,
      bol_id: true,
      shipment_date: true,
      shipment_date_raw: true,
      total_weight_lbs: true,
      total_weight_check_lbs: true,
      materials_status: true,
      status: true,
    },
    take: 1200,
  });

  const staged = rows.filter((r) => r.status === 'staged');
  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const stagedVersionId = staged[0]?.doc_source_version_id ?? null;

  const commodityCount =
    stagedVersionId === null
      ? 0
      : await prisma.docOutboundCommodityRow.count({
          where: { doc_source_version_id: stagedVersionId, status: 'staged' },
        });

  const sum = (rs: typeof rows): number => rs.reduce((a, r) => a + Number(r.total_weight_lbs ?? 0), 0);
  const stagedWeight = sum(staged);
  const confirmedWeight = sum(confirmed);
  const sheets = [...new Set(staged.map((r) => r.sheet_name))];
  const undated = staged.filter((r) => r.shipment_date === null).length;
  // The sign check, recomputed on what is actually stored — not read back from
  // the absorb note. A note describes what an extractor believed; this is what
  // the rows say.
  const signDisagreements = staged.filter(
    (r) =>
      r.total_weight_lbs !== null &&
      r.total_weight_check_lbs !== null &&
      Math.abs(Number(r.total_weight_check_lbs) + Number(r.total_weight_lbs)) > 1,
  );

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/admin/doc-ingest"
          className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
        >
          ← Document ingestion
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Outbound weights</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          Shipped loads and their per-commodity weights, read from the Woodland Outbound Auditing
          workbook. Rows are <strong>staged</strong> and count only once you accept them
          (ADR-0104 §D5). Reference data — it feeds no invoice, payable or billing figure, and it
          writes no operational table.
        </p>

        {rows.length === 0 ? (
          <p className="mt-8 rounded-lg bg-dr3-steel/20 p-6 text-sm text-dr3-mist-dim">
            Nothing extracted yet. The outbound workbook absorbs once its class and site are
            confirmed on the{' '}
            <Link href="/admin/doc-ingest" className="text-dr3-cyan underline">
              confirm queue
            </Link>
            .
          </p>
        ) : (
          <>
            {staged.length > 0 && stagedVersionId && (
              <section className="mt-6 rounded-lg bg-amber-500/10 p-5 ring-1 ring-amber-500/30">
                <h2 className="text-lg font-semibold text-amber-200">
                  {staged.length} load{staged.length === 1 ? '' : 's'} waiting for you
                </h2>

                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Total weight" value={lbs(stagedWeight)} tone="warn" />
                  <Stat label="Loads" value={String(staged.length)} />
                  <Stat label="Commodity rows" value={String(commodityCount)} />
                  <Stat
                    label="No usable date"
                    value={String(undated)}
                    hint="kept, shown as written"
                  />
                </div>

                <p className="mt-4 text-sm leading-relaxed text-amber-100/90">
                  Read from{' '}
                  <strong>{sheets.map((s) => `“${s}”`).join(', ') || '(no sheet)'}</strong>. The
                  workbook contains <strong>four pairs of sheets that are exact copies</strong> of
                  one another plus one filtered subset sheet, so the same shipment appears more than
                  once. Duplicates were removed on the Materials ID, which means this total is{' '}
                  <strong>the real tonnage, not roughly 1.7× it</strong>. Its five pivot tabs
                  (Foam_Topper, Wood, steel, trash, other) were deliberately left alone: they carry
                  $/ton, total cost and gross profit, all recomputable from these load rows.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-amber-100/90">
                  Weights come from <strong>Total Outbound Weight</strong>. The workbook’s
                  right-most column, <em>Total Outbound Materials Weight</em>, holds the{' '}
                  <strong>negation</strong> of that figure; it is stored only so this check can be
                  made.{' '}
                  {signDisagreements.length === 0 ? (
                    <>Every staged load agrees with it.</>
                  ) : (
                    <>
                      <strong>{signDisagreements.length} load(s) disagree</strong> (
                      {signDisagreements
                        .slice(0, 5)
                        .map((r) => r.external_materials_id)
                        .join(', ')}
                      ) — the positive column was used, as always, and the disagreement is shown
                      rather than smoothed over.
                    </>
                  )}
                </p>

                <StagedBatchReviewClient
                  endpoint="/api/admin/doc-ingest/outbound"
                  versionId={stagedVersionId}
                  subject={`${staged.length} loads`}
                  confirmBody={`Accepting records these ${staged.length} loads and ${commodityCount} commodity rows — ${lbs(stagedWeight)} in total — as reviewed by you. They stay reference data: nothing is billed, paid or reported from them, and no operational table is written.`}
                  discardPlaceholder="e.g. the workbook was mid-edit when it was read"
                  testIdPrefix="outbound"
                />
              </section>
            )}

            {confirmed.length > 0 && (
              <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
                <Stat label="Confirmed loads" value={String(confirmed.length)} tone="ok" />
                <Stat label="Confirmed weight" value={lbs(confirmedWeight)} tone="ok" />
              </div>
            )}

            <div className="mt-6 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
                  <tr>
                    <th className="px-3 py-2">Shipped</th>
                    <th className="px-3 py-2">Materials ID</th>
                    <th className="px-3 py-2">BOL</th>
                    <th className="px-3 py-2 text-right">Weight</th>
                    <th className="px-3 py-2">Materials status</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2 text-right">Sheet · row</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t border-dr3-steel-light/15 align-top"
                      data-testid="outbound-row"
                    >
                      <td className="px-3 py-2 tabular-nums">
                        {r.shipment_date ? (
                          r.shipment_date.toISOString().slice(0, 10)
                        ) : (
                          <span
                            className="text-amber-300"
                            title="the sheet's date could not be read as a date; shown as written"
                          >
                            {r.shipment_date_raw ?? '—'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.external_materials_id}</td>
                      <td className="px-3 py-2 text-dr3-mist-dim">{r.bol_id ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.total_weight_lbs === null ? (
                          <span className="text-dr3-mist-dim/60">not recorded</span>
                        ) : (
                          lbs(Number(r.total_weight_lbs))
                        )}
                      </td>
                      <td className="px-3 py-2 text-dr3-mist-dim">{r.materials_status ?? '—'}</td>
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
              A load with no weight in the sheet shows as “not recorded”, never 0 lb. Shipment dates
              arrive three ways across the sheets — as real dates, as Excel serial numbers, and as
              text — and all three are converted; a cell that could not be read as any of them is
              shown exactly as written rather than guessed into a day. At most 1,200 rows are listed;
              the totals above are computed over the same set.
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
