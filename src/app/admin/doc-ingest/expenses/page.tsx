// ADR-0104 §D4/§D5 — the facility expense-log preview.
//
// Money, so it stages. The two things this screen must say plainly, because
// neither is visible in a total:
//
//   1. WHAT THE DATES ARE. The workbook's `Invoice Date` column holds
//      DAY-OF-MONTH numbers, not dates — the month lives in banner rows written
//      into the sheet body. The day and the banner are shown as the sheet wrote
//      them and are NEVER composed into a date, because 40 of the rows sit above
//      the first banner and one sheet carries two blocks both labelled "July".
//   2. WHICH SHEETS WERE REFUSED. Two of the five are STOCKTON, which has no row
//      in `sites`, and a workbook where three of five sheets declined must not
//      look identical to one where all five were read.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { StagedBatchReviewClient } from '../StagedBatchReviewClient';

export const dynamic = 'force-dynamic';

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function FacilityExpensesPreviewPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">Facility expense data is restricted to administrators.</p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const rows = await prisma.docFacilityExpenseRow.findMany({
    where: { status: { in: ['staged', 'confirmed'] } },
    orderBy: [{ status: 'asc' }, { sheet_name: 'asc' }, { row_index: 'asc' }],
    select: {
      id: true,
      doc_source_version_id: true,
      sheet_name: true,
      sheet_year: true,
      row_index: true,
      invoice_date: true,
      invoice_date_raw: true,
      invoice_month_label: true,
      invoice_day: true,
      amount: true,
      credit_amount: true,
      category_raw: true,
      invoice_number: true,
      notes: true,
      commodity_raw: true,
      haul_ref: true,
      status: true,
    },
    take: 800,
  });

  const staged = rows.filter((r) => r.status === 'staged');
  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const stagedVersionId = staged[0]?.doc_source_version_id ?? null;

  const total = (rs: typeof rows, pick: (r: (typeof rows)[number]) => unknown): number =>
    rs.reduce((a, r) => a + Number(pick(r) ?? 0), 0);
  const stagedAmount = total(staged, (r) => r.amount);
  const stagedCredit = total(staged, (r) => r.credit_amount);
  const confirmedAmount = total(confirmed, (r) => r.amount);
  const noAmount = staged.filter((r) => r.amount === null).length;
  const sheets = [...new Set(staged.map((r) => r.sheet_name))];
  const withRealDate = staged.filter((r) => r.invoice_date !== null).length;
  const aboveFirstBanner = staged.filter((r) => r.invoice_month_label === null).length;
  const hauls = staged.filter((r) => r.haul_ref !== null).length;

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/admin/doc-ingest"
          className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
        >
          ← Document ingestion
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Facility expenses</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          A hand-kept desk log of expenses already paid, read from the Woodland Invoices tracking
          workbook. This document carries <strong>money</strong>, so rows are{' '}
          <strong>staged</strong> and count only once you accept them (ADR-0104 §D5). Reference data
          — these are <strong>not</strong> payables and nothing here writes the invoices table.
        </p>

        {rows.length === 0 ? (
          <p className="mt-8 rounded-lg bg-dr3-steel/20 p-6 text-sm text-dr3-mist-dim">
            Nothing extracted yet. The expense workbook absorbs once its class and site are confirmed
            on the{' '}
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
                  {staged.length} expense row{staged.length === 1 ? '' : 's'} waiting for you
                </h2>

                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Amount" value={usd(stagedAmount)} tone="warn" />
                  <Stat label="Credited" value={usd(stagedCredit)} />
                  <Stat label="Rows" value={String(staged.length)} />
                  <Stat
                    label="No amount recorded"
                    value={String(noAmount)}
                    hint="kept, never counted as $0"
                  />
                </div>

                <p className="mt-4 text-sm leading-relaxed text-amber-100/90">
                  Read from{' '}
                  <strong>{sheets.map((s) => `“${s}”`).join(' and ') || '(no sheet)'}</strong>. The
                  workbook’s <strong>STOCKTON</strong> sheets were refused: Stockton is not a
                  registered site, and attributing its expenses to Woodland would be worse than not
                  having them. Each sheet’s own <em>Monthly Total</em> and <em>Yearly Total</em> rows
                  were skipped — absorbing them would have added the sheet’s arithmetic on top of
                  the sheet.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-amber-100/90">
                  <strong>About the dates.</strong> This workbook’s <em>Invoice Date</em> column
                  holds a <strong>day of the month</strong>, not a date — the month is written as a
                  banner row inside the sheet.{' '}
                  <strong>
                    {withRealDate} of {staged.length}
                  </strong>{' '}
                  rows carry a cell a full date could be read from, and{' '}
                  <strong>{aboveFirstBanner}</strong> sit above the first month banner, so their
                  month is genuinely unstated. The day and the banner are shown exactly as written
                  and are never combined into a date the operator did not record.
                  {hauls > 0 ? ` ${hauls} row(s) name an H-haul in the commodity column.` : ''}
                </p>

                <StagedBatchReviewClient
                  endpoint="/api/admin/doc-ingest/expenses"
                  versionId={stagedVersionId}
                  subject={`${staged.length} rows`}
                  confirmBody={`Accepting records these ${staged.length} expense rows — ${usd(stagedAmount)} of expenses and ${usd(stagedCredit)} of credits — as reviewed by you. They stay reference data: no payable is created and no invoice record is written.`}
                  discardPlaceholder="e.g. the workbook was mid-edit when it was read"
                  testIdPrefix="expenses"
                />
              </section>
            )}

            {confirmed.length > 0 && (
              <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
                <Stat label="Confirmed rows" value={String(confirmed.length)} tone="ok" />
                <Stat label="Confirmed amount" value={usd(confirmedAmount)} tone="ok" />
              </div>
            )}

            <div className="mt-6 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
                  <tr>
                    <th className="px-3 py-2">When</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2">Invoice #</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2 text-right">Sheet · row</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t border-dr3-steel-light/15 align-top"
                      data-testid="expense-row"
                    >
                      <td className="px-3 py-2 tabular-nums">
                        {r.invoice_date ? (
                          r.invoice_date.toISOString().slice(0, 10)
                        ) : (
                          <span
                            title="the sheet records a day of the month under a month banner, not a date"
                            className="text-dr3-mist-dim"
                          >
                            {r.invoice_month_label ?? (
                              <span className="text-amber-300">month not stated</span>
                            )}{' '}
                            {r.invoice_day ?? r.invoice_date_raw ?? '—'}
                            {r.sheet_year ? ` · ${r.sheet_year}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[22ch] px-3 py-2">{r.category_raw ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.amount === null ? (
                          <span className="text-dr3-mist-dim/60">not recorded</span>
                        ) : (
                          usd(Number(r.amount))
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                        {r.credit_amount === null ? '—' : usd(Number(r.credit_amount))}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-dr3-mist-dim">
                        {r.invoice_number ?? '—'}
                      </td>
                      <td className="max-w-[34ch] px-3 py-2 text-dr3-mist-dim">
                        {r.notes ?? '—'}
                        {r.haul_ref ? (
                          <span className="ml-1 rounded bg-dr3-cyan/15 px-1 text-xs text-dr3-cyan">
                            {r.haul_ref}
                          </span>
                        ) : null}
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
              An expense with no amount in the sheet shows as “not recorded”, never $0.00 — an
              expense nobody priced is not a free expense. Categories are shown exactly as typed,
              including the case variants the sheets contain (“Transportation” and “transportation”
              are two spellings of one category, and neither was rewritten). At most 800 rows are
              listed; the totals above are computed over the same set.
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
