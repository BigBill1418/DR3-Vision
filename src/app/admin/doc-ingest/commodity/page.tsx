// ADR-0080 Phase 2 — the commodity audit-coverage grid.
//
// ── What this screen is for ────────────────────────────────────────────────
// The Woodland Data Auditing Tracker records, per commodity stream × month,
// whether that month's audit against vendor invoices was done, by whom, and when.
// The queryable fact is COVERAGE — which months nobody has checked yet — so that
// is what this grid shows, and it shows nothing else. There is no tonnage and no
// money anywhere in the source document (verified against the live bytes
// 2026-08-07), so there is no total on this page and there never should be one.
//
// ── DISPLAY ONLY — no reconciliation rules, deliberately ───────────────────
// This screen adds NO divergence threshold, flags NO disagreement between this
// document and any other, and nominates NO authoritative source. Those rules are
// DEFERRED pending a stakeholder interview and are explicitly out of scope. A
// threshold invented at render time would be a guess that looks like a finding —
// and because this document has no figures to compare, the only "divergence" one
// could invent here would be against `processed_units_daily`, whose one writer is
// workbook-sync (ADR-0049) and which this document has nothing to say about.
//
// ── Three states per cell, never two ───────────────────────────────────────
// Audited / not audited / NOT RECORDED. The third is the whole point: an empty
// Audited cell means nobody wrote an answer, which is a different fact from a
// recorded "no", and it is the finding this document exists to surface. It is
// rendered as its own state with its own words.
//
// ── The mess is shown as written ───────────────────────────────────────────
// Three of the live 2026 METAL block's Date cells hold the literal word
// "working". It is a status, not a date, and it is printed verbatim beside the
// cell rather than being rendered as a date that would then look authoritative.
//
// READ-ONLY. There is no confirm control on this page and no mutation behind it
// — a confirm writes an operator's name (O-2), so it must be a human's, and it
// goes through the existing operator path.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  computeCommodityCoverage,
  sitesWithCommodityCoverage,
  type CommodityCoverage,
  type CommodityCoverageCell,
  type CommoditySheetCoverage,
  type CoverageTally,
} from '@/lib/doc-ingest/commodity-ledger';

export const dynamic = 'force-dynamic';

export default async function CommodityCoveragePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">Document ingestion is restricted to administrators.</p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const sites = await sitesWithCommodityCoverage();
  const perSite = await Promise.all(
    sites.map(async (site) => ({
      site,
      confirmed: await computeCommodityCoverage(site.id, { scope: 'confirmed' }),
      staged: await computeCommodityCoverage(site.id, { scope: 'staged' }),
    })),
  );

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-7xl">
        <Link
          href="/admin/doc-ingest"
          className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
        >
          ← Document ingestion
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Commodity audit coverage</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          Which months of each commodity stream have been audited against vendor invoices
          (ADR-0080). This document carries <strong>no tonnage and no money</strong> — the only
          figure it can produce is a count of months, so there is no total on this page. Reference
          data: it feeds no billing, payroll, inventory or COR figure, and it is not compared
          against any other source.
        </p>

        {perSite.length === 0 ? (
          <p className="mt-8 rounded-lg bg-dr3-steel/20 p-6 text-sm text-dr3-mist-dim">
            Nothing absorbed yet. The tracker absorbs once its class and site are confirmed on the{' '}
            <Link href="/admin/doc-ingest" className="text-dr3-cyan underline">
              confirm queue
            </Link>
            .
          </p>
        ) : (
          perSite.map(({ site, confirmed, staged }) => (
            <SiteSection key={site.id} name={site.name} confirmed={confirmed} staged={staged} />
          ))
        )}

        <p className="mt-8 max-w-3xl text-xs leading-relaxed text-dr3-mist-dim">
          A blank Audited cell shows as <strong>not recorded</strong>, never as “not audited” — “we
          checked and it is not done” and “nobody wrote anything” are different facts, and only the
          second one tells you where to look next. A Date cell the sheet did not write as a date —
          the live file contains the literal word “working” — is printed exactly as written rather
          than turned into a day. Month labels are the sheet’s own (“Sept”, “March”); normalising
          them would quietly merge two columns.
        </p>
      </div>
    </main>
  );
}

function SiteSection({
  name,
  confirmed,
  staged,
}: {
  name: string;
  confirmed: CommodityCoverage;
  staged: CommodityCoverage;
}) {
  // Confirmed is what this site's coverage IS. Staged is a reading nobody has
  // accepted, so it is shown only when there is no confirmed revision to show,
  // and when it is shown it is labelled as a preview throughout. The two are
  // never merged into one grid: both carry a complete copy of the workbook, so a
  // merged grid would be double-counted as well as dishonest.
  const showing = confirmed.awaiting ? staged : confirmed;
  const isPreview = confirmed.awaiting && !staged.awaiting;

  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold">{name}</h2>

      {confirmed.awaiting && staged.awaiting ? (
        <p className="mt-3 rounded-lg bg-dr3-steel/20 p-5 text-sm text-dr3-mist-dim">
          No commodity audit rows for this site.
        </p>
      ) : (
        <>
          {isPreview ? (
            <div className="mt-3 rounded-lg bg-amber-500/10 p-4 text-sm ring-1 ring-amber-500/30">
              <strong className="text-amber-200">Staged — not yet accepted.</strong>{' '}
              <span className="text-amber-100/90">
                {staged.rowsConsidered} row(s) were extracted from revision{' '}
                <code className="text-xs">{staged.versionId}</code> and are waiting for a person to
                confirm them. Staging is not about money — this document has none. It is because
                this layout has only just been understood, and an absorption of a newly-understood
                layout must not become fact on its own say-so. Confirming writes an operator’s name
                against the batch, so it has to be a human’s: there is no confirm control on this
                page.
              </span>
            </div>
          ) : (
            <div className="mt-3 rounded-lg bg-emerald-500/10 p-4 text-sm ring-1 ring-emerald-500/30">
              <strong className="text-emerald-200">Confirmed.</strong>{' '}
              <span className="text-emerald-100/90">
                Showing revision <code className="text-xs">{confirmed.versionId}</code> only —{' '}
                {confirmed.rowsConsidered} row(s). A newer revision supersedes its predecessor
                rather than adding to it, so earlier confirmed revisions of the same workbook are
                deliberately not summed in.
                {!staged.awaiting &&
                  ` A newer batch of ${staged.rowsConsidered} row(s) is staged and awaiting confirmation.`}
              </span>
            </div>
          )}

          <p className="mt-2 text-xs text-dr3-mist-dim">
            Absorbed {showing.absorbedAtISO?.replace('T', ' ').slice(0, 16) ?? '—'} UTC
          </p>

          <TallyRow label="Audit" tally={showing.audit} />
          <TallyRow label="Second audit" tally={showing.secondAudit} />

          {showing.sheets.map((sheet) => (
            <SheetGrid key={sheet.sheetName} sheet={sheet} />
          ))}
        </>
      )}
    </section>
  );
}

function TallyRow({ label, tally }: { label: string; tally: CoverageTally }) {
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div className="mt-1 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Months audited" value={String(tally.audited)} tone="ok" />
        <Stat label="Months not audited" value={String(tally.notAudited)} tone="warn" />
        <Stat
          label="Months not recorded"
          value={String(tally.notRecorded)}
          hint="nobody wrote an answer"
        />
        <Stat label="Month rows" value={String(tally.rows)} />
      </div>
    </div>
  );
}

function SheetGrid({ sheet }: { sheet: CommoditySheetCoverage }) {
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold">
        {sheet.sheetName}{' '}
        <span className="font-normal text-dr3-mist-dim">
          · year {sheet.sheetYear ?? 'not readable'} · {sheet.streams.length} stream(s) ·{' '}
          {sheet.audit.rows} month row(s)
        </span>
      </h3>

      <div className="mt-2 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
            <tr>
              <th className="px-3 py-2">Stream</th>
              {sheet.monthLabels.map((m) => (
                <th key={m} className="px-2 py-2 text-center">
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Done · not · unrecorded</th>
            </tr>
          </thead>
          <tbody>
            {sheet.streams.map((stream) => (
              <tr
                key={stream.streamLabel}
                className="border-t border-dr3-steel-light/15 align-top"
                data-testid="commodity-stream"
              >
                <td className="px-3 py-2">
                  <div className="font-medium">{stream.streamLabel || '(unlabelled)'}</div>
                  <div className="text-xs text-dr3-mist-dim/70">{stream.streamGroup}</div>
                </td>
                {stream.cells.map((cell, i) => (
                  <td key={sheet.monthLabels[i] ?? i} className="px-2 py-2 text-center">
                    <MonthCell cell={cell} />
                  </td>
                ))}
                <td className="px-3 py-2 text-right text-xs tabular-nums text-dr3-mist-dim">
                  {stream.audit.audited} · {stream.audit.notAudited} · {stream.audit.notRecorded}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * One stream × one month.
 *
 * Four renderings, because there are four distinct facts: audited, not audited,
 * NOT RECORDED, and "this stream has no row for this month at all" (which the
 * grid can produce and the tallies deliberately do not count as an answer).
 */
function MonthCell({ cell }: { cell: CommodityCoverageCell | null }) {
  if (cell === null) {
    return (
      <span className="text-dr3-mist-dim/30" title="this stream has no row for this month">
        ·
      </span>
    );
  }

  const mark =
    cell.audited === true ? (
      <span className="text-emerald-300" title="audited">
        ✓
      </span>
    ) : cell.audited === false ? (
      <span className="text-rose-300" title="recorded as not audited">
        ✕
      </span>
    ) : (
      <span
        className="text-dr3-mist-dim/60"
        title="NOT RECORDED — the sheet holds no answer for this month. This is not the same as “not audited”."
      >
        —
      </span>
    );

  // The raw text of a Date cell that was not a date — the live file's "working".
  // Shown verbatim. '' means the cell existed and was blank, which is not worth
  // printing; a non-empty raw with no parsed date is.
  const rawOnly =
    cell.auditDateISO === null && cell.auditDateRaw !== null && cell.auditDateRaw.trim() !== ''
      ? cell.auditDateRaw
      : null;

  return (
    <div className="leading-tight">
      <div className="text-base">{mark}</div>
      {cell.initials && <div className="text-[10px] text-dr3-mist-dim/70">{cell.initials}</div>}
      {cell.auditDateISO && (
        <div className="text-[10px] tabular-nums text-dr3-mist-dim/60">{cell.auditDateISO}</div>
      )}
      {rawOnly && (
        <div
          className="text-[10px] text-amber-300"
          title="the sheet did not write a date here; shown exactly as written"
        >
          {rawOnly}
        </div>
      )}
      {cell.secondAudit === true && (
        <div className="text-[10px] text-cyan-300" title="second audit recorded">
          2nd{cell.secondInitials ? ` ${cell.secondInitials}` : ''}
        </div>
      )}
    </div>
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
    tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-rose-300' : 'text-dr3-mist';
  return (
    <div className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20">
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-dr3-mist-dim/70">{hint}</div>}
    </div>
  );
}
