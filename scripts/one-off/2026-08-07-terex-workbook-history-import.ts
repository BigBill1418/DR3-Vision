// ADR-0081 — one-off: import the TEREX workbook's monthly history.
//
// Bill's written instruction is the authorisation: "use the excel sheet to pull
// in the historical data - then STARTING TODAY you will just take in the data
// that JT enters here but ALL OF THAT DATA needs to be aggregated and displayed
// IN THIS PAGE."
//
// WHY A SCRIPT, and why it drives the SERVICE. Same reasoning as
// `2026-08-06-terex-classify-apply-accept.ts`: this calls
// `importWorkbookHistory` — the identical function the admin surface calls —
// rather than hand-written SQL, so the reconciliation hard stop, the JT-wins
// `ON CONFLICT` guard, the version-scoped supersession and the audit row all
// apply. Hand-rolled SQL here would skip every one of them.
//
// WHO IT SAYS DID IT: `actor_label = 'system:workbook-import'`, `created_by`
// NULL. A label, never a borrowed `users.id` (ADR-0036 / ADR-0077).
//
// WHERE IT RUNS: INSIDE the cluster. The workstation has no R2 credentials, so
// the archived bytes are unreachable from it — the same constraint ADR-0069
// Am.2's script records.
//
//   docker exec -w /app dr3-vision-app node <bundled> preview
//   docker exec -w /app dr3-vision-app node <bundled> apply
//
// STEPS ARE SEPARATE ON PURPOSE. `preview` is read-only, writes nothing, and
// must be run and SEEN before `apply`. `apply` refuses by itself if any month
// fails to reconcile (ADR-0081 R5), but a human reading the per-tab table is the
// point of the preview, not a formality.

import { prisma } from '../../src/lib/prisma';
import { getFileDropBytes } from '../../src/lib/r2';
import { resolveSiteThroughputMachine } from '../../src/lib/equipment/daily-throughput';
import {
  importWorkbookHistory,
  type WorkbookImportReport,
} from '../../src/lib/equipment/workbook-import';

/** The registered TEREX workbook (ADR-0069 Am.2 / ADR-0077 D5). */
const DOC_SOURCE_ID = '8a0246e7-dbb0-4de2-a90f-ddc5d4b2de4b';

function fmt(n: number, dp = 2): string {
  return n.toFixed(dp).padStart(9);
}

function printReport(report: WorkbookImportReport): void {
  const { extraction } = report;

  console.log('\n══ PER-TAB ═══════════════════════════════════════════════════');
  for (const tab of extraction.tabs) {
    if (tab.status === 'skipped') {
      console.log(`  ${tab.name.padEnd(14)} SKIP  ${tab.skipReason}`);
      continue;
    }
    const rc = tab.reconciliation
      .filter((c) => c.published !== null)
      .map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.label.split(' (')[0]}`)
      .join(' · ');
    console.log(
      `  ${tab.name.padEnd(14)} rows ${String(tab.rowsExtracted).padStart(3)}/${String(tab.dayRowsSeen).padStart(3)}` +
        `  units ${fmt(tab.parsedUnits, 0)}  hours ${fmt(tab.parsedHours)}  | ${rc}`,
    );
    const byReason = new Map<string, number>();
    for (const s of tab.skips) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    if (byReason.size > 0) {
      console.log(
        `  ${' '.repeat(14)} skipped rows: ${[...byReason].map(([k, v]) => `${k}=${v}`).join(', ')}`,
      );
    }
    // Rows the tab carries that its OWN totals formula does not add up. A defect
    // in the source document, surfaced so it can be fixed there.
    for (const g of tab.coverageGap) {
      console.log(
        `  ${' '.repeat(14)} ⚠ WORKBOOK COVERAGE GAP row ${g.rowIndex} (${g.dateISO}): ` +
          `${g.units} units / ${g.hours ?? 'no'} hrs are outside the tab's own ${g.missingFrom.join('+')} SUM range`,
      );
    }
    for (const s of tab.skips.filter((x) => x.reason === 'units_not_integer')) {
      console.log(`  ${' '.repeat(14)} ⚠ NON-INTEGER row ${s.rowIndex}: ${s.detail}`);
    }
  }

  console.log('\n══ SUMMARY ═══════════════════════════════════════════════════');
  console.log(`  version           ${report.versionId}`);
  console.log(`  rows offered      ${report.rowsOffered}`);
  console.log(
    `  date range        ${report.dateRange ? `${report.dateRange.firstISO} .. ${report.dateRange.lastISO}` : '(none)'}`,
  );
  console.log(
    `  reconciled        ${report.stagedForReconciliation ? 'NO — STAGED' : 'yes, all tabs'}`,
  );
  if (report.offendingTabs.length > 0) {
    console.log(`  offending tabs    ${report.offendingTabs.join(', ')}`);
  }
  console.log(`  already applied   ${report.alreadyApplied}`);
  console.log(`  APPLIED           ${report.applied}`);
  console.log(`  rows written      ${report.rowsWritten}`);
  console.log(`  rows superseded   ${report.rowsSuperseded}`);
  console.log(
    `  yielded to JT     ${report.rowsYieldedToManager.length}` +
      (report.rowsYieldedToManager.length > 0
        ? ` (${report.rowsYieldedToManager.join(', ')})`
        : ''),
  );
}

async function main(): Promise<void> {
  const step = process.argv[2];
  if (step !== 'preview' && step !== 'apply') {
    console.error('usage: <script> preview|apply');
    process.exit(2);
  }

  const source = await prisma.docSource.findUnique({
    where: { id: DOC_SOURCE_ID },
    select: { id: true, display_name: true, site_id: true },
  });
  if (!source?.site_id) throw new Error(`doc source ${DOC_SOURCE_ID} missing or unclassified`);

  // The NEWEST applied revision — the one whose bytes are current. Reading it
  // rather than hardcoding a version id means a re-run after the next
  // SharePoint save picks up the new revision and supersedes (ADR-0081 R4).
  const version = await prisma.docSourceVersion.findFirst({
    where: { doc_source_id: DOC_SOURCE_ID, applied_at: { not: null } },
    orderBy: { applied_at: 'desc' },
    select: { id: true, r2_key: true, size_bytes: true, content_sha256: true },
  });
  if (!version?.r2_key) throw new Error('newest applied version has no archived object');

  // ADR-0079 D1 / ADR-0077 identity rule — the machine is RESOLVED from the
  // registry by evidence, never by a literal id.
  const machine = await resolveSiteThroughputMachine(source.site_id);
  if (!machine) throw new Error(`no throughput machine resolves at site ${source.site_id}`);

  const bytes = await getFileDropBytes(version.r2_key);
  if (!bytes) throw new Error(`could not read ${version.r2_key} back from R2`);

  console.log('══ SOURCE ════════════════════════════════════════════════════');
  console.log(`  document   ${source.display_name} (${source.id})`);
  console.log(`  version    ${version.id}`);
  console.log(`  bytes      ${bytes.length} (recorded ${version.size_bytes ?? '?'})`);
  console.log(`  sha256     ${version.content_sha256 ?? '(none recorded)'}`);
  console.log(`  machine    ${machine.displayName} (${machine.id})`);
  console.log(`  step       ${step}`);

  const report = await importWorkbookHistory({
    siteId: source.site_id,
    equipmentId: machine.id,
    versionId: version.id,
    bytes,
    apply: step === 'apply',
  });

  printReport(report);

  if (report.stagedForReconciliation) {
    console.error(
      '\nSTAGED — nothing was applied. One or more months do not reconcile against the ' +
        "workbook's own totals. Resolve the offenders above before re-running.",
    );
    process.exit(1);
  }
  if (step === 'preview') {
    console.log('\nPreview only — nothing was written. Re-run with `apply` to write.');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
