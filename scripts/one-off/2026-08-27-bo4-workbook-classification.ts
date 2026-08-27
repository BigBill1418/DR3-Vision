// OPEN-ITEMS §0.BO BO-4 / §0.BQ — the transport-charge classification, read from
// the workbook that has always owned it.
//
// Bill's call (2026-08-27): import `is_trans_charge` + `canonical_mileage` from
// the Woodland workbook's `list` tab (~47 trans-charge sites) and
// `variables!Mileage_Table` (61 rows), STAGED for his review — applied only on
// his confirm. ADR-0128 D10 stands: no guess is ever seeded; this script copies
// what the workbook says and refuses everything it cannot match exactly.
//
// MODES (mutually exclusive; default is --stage):
//   --inspect  dump the raw `list` + `variables` sheet structure (bounded) so a
//              human can verify the extraction assumptions before trusting them.
//   --stage    extract, match against `sources` via the alias resolver, and
//              print the full proposal table. WRITES NOTHING.
//   --apply    execute a previously reviewed proposal: set is_trans_charge +
//              canonical_mileage on matched sources, one audit row per write.
//              Refuses to run unless --i-reviewed-the-stage is also passed.
//
// RUN (from a checkout with node_modules; Graph + DB env exported):
//   npx tsx scripts/one-off/2026-08-27-bo4-workbook-classification.ts --inspect
//
// The workbook is fetched EXACTLY the way workbook-sync fetches it: the active
// Woodland `workbook_sources` row names the drive/folder/file pattern, and the
// shared msgraph-files transport downloads the current month's file. No new
// access path, no cached copy.

import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { selectFilesTransport } from '@/lib/msgraph-files';
import { resolveMonthlyFileName, resolveMonthlyFolderPath } from '@/lib/workbook-sync/naming';
import { sourceAliasResolver } from '@/lib/audit/workbook/site-alias';
import { cellText, cellNumber } from '@/lib/audit/workbook/section-resolver';

const MODE = process.argv.includes('--inspect')
  ? 'inspect'
  : process.argv.includes('--apply')
    ? 'apply'
    : 'stage';
const REVIEWED = process.argv.includes('--i-reviewed-the-stage');
const prisma = new PrismaClient();

const BILL_EMAIL = 'bill.barnard@svdp.us';

async function downloadWorkbook(): Promise<{
  wb: ExcelJS.Workbook;
  fileName: string;
  siteId: string;
}> {
  const woodland = await prisma.site.findFirst({
    where: { code: 'woodland' },
    select: { id: true },
  });
  if (!woodland) throw new Error('no woodland site row');
  const source = await prisma.workbookSource.findFirst({ where: { site_id: woodland.id } });
  if (!source) throw new Error('no Woodland workbook_sources row');
  const transport = await selectFilesTransport((level, message) =>
    console.error(`[transport ${level}] ${message}`),
  );
  const now = new Date();
  const fileName = resolveMonthlyFileName(source.naming_pattern, now);
  const folderPath = resolveMonthlyFolderPath(source.folder_path, now);
  const listing = await transport.listFolder(source.drive_upn, folderPath);
  const file = listing.find((f) => f.name === fileName);
  if (!file) {
    throw new Error(
      `"${fileName}" not found in ${folderPath} (saw: ${listing.map((f) => f.name).join(', ')})`,
    );
  }
  const bytes = await transport.downloadFile(source.drive_upn, file.id);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return { wb, fileName, siteId: woodland.id };
}

function dumpSheet(ws: ExcelJS.Worksheet, maxRows: number, maxCols: number) {
  console.log(`\n── sheet "${ws.name}" (${ws.rowCount} rows × ${ws.columnCount} cols) ──`);
  for (let r = 1; r <= Math.min(ws.rowCount, maxRows); r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= Math.min(ws.columnCount, maxCols); c++) {
      const t = cellText(row.getCell(c).value);
      cells.push(t === null ? '·' : t.slice(0, 44));
    }
    if (cells.some((c) => c !== '·')) console.log(String(r).padStart(3), cells.join(' | '));
  }
}

/** Sheets whose name case-insensitively contains any of the needles. */
function sheetsLike(wb: ExcelJS.Workbook, ...needles: string[]): ExcelJS.Worksheet[] {
  return wb.worksheets.filter((ws) =>
    needles.some((n) => ws.name.toLowerCase().includes(n.toLowerCase())),
  );
}

async function main() {
  if (MODE === 'apply' && !REVIEWED) {
    throw new Error(
      '--apply requires --i-reviewed-the-stage (run --stage first, review, then apply)',
    );
  }
  const { wb, fileName, siteId } = await downloadWorkbook();
  console.log(`workbook: ${fileName}`);
  console.log(`sheets: ${wb.worksheets.map((w) => w.name).join(' · ')}`);
  const defined = (wb as unknown as { definedNames?: { model?: unknown } }).definedNames;
  console.log(`definedNames model:`, JSON.stringify(defined?.model ?? null)?.slice(0, 800));

  const listSheets = sheetsLike(wb, 'list');
  const varSheets = sheetsLike(wb, 'variable');

  if (MODE === 'inspect') {
    for (const ws of listSheets) dumpSheet(ws, 95, 8);
    for (const ws of varSheets) dumpSheet(ws, 95, 31);
    return;
  }

  // ── Extraction (layout confirmed by --inspect against the AUGUST 2026 file) ──
  //
  // `list` sheet: row 1 headers; column F ("trans charge") is the roster of
  // transport-charged sites, one name per row until the column runs dry.
  //
  // `variables` sheet: three side-by-side tables. Cols H–Q (8–17) are the
  // Mileage_Table: Account Name | Destination (DR3 Woodland / DR3 Stockton /
  // DR3 - Livermore) | Haul Rate | Mileage | Assignment (Primary/Secondary/
  // Tertiary) | Re-Trac ID | rental columns. Cols U–AD (21–30) are a
  // near-duplicate second copy; both are read and disagreements are FLAGGED,
  // never averaged. The mileage we stage is the DR3 Woodland Primary row.
  const listWs = listSheets[0];
  const varWs = varSheets[0];
  if (!listWs || !varWs) throw new Error('list/variables sheet not found');

  const transChargeNames: string[] = [];
  for (let r = 2; r <= listWs.rowCount; r++) {
    const t = cellText(listWs.getRow(r).getCell(6).value);
    if (t && t.trim()) transChargeNames.push(t.trim());
  }

  interface MileRow {
    name: string;
    dest: string;
    mileage: number | null;
    haulRate: number | null;
    assignment: string | null;
  }
  const readTable = (nameCol: number): MileRow[] => {
    const rows: MileRow[] = [];
    for (let r = 2; r <= varWs.rowCount; r++) {
      const row = varWs.getRow(r);
      const name = cellText(row.getCell(nameCol).value)?.trim();
      const dest = cellText(row.getCell(nameCol + 1).value)?.trim();
      if (!name || !dest) continue;
      rows.push({
        name,
        dest,
        haulRate: cellNumber(row.getCell(nameCol + 2).value),
        mileage: cellNumber(row.getCell(nameCol + 3).value),
        assignment: cellText(row.getCell(nameCol + 4).value)?.trim() ?? null,
      });
    }
    return rows;
  };
  const tableA = readTable(8); // cols H..
  const tableB = readTable(21); // cols U..

  const woodlandPrimary = (rows: MileRow[], name: string): MileRow | undefined => {
    const mine = rows.filter(
      (r) => r.name.toLowerCase() === name.toLowerCase() && /woodland/i.test(r.dest),
    );
    return mine.find((r) => /primary/i.test(r.assignment ?? '')) ?? mine[0];
  };

  const resolver = await sourceAliasResolver(prisma);
  const sources = await prisma.source.findMany({
    where: { site_id: siteId },
    select: { id: true, name: true, is_trans_charge: true, canonical_mileage: true },
  });
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  interface Proposal {
    workbookName: string;
    sourceId: string | null;
    sourceName: string | null;
    mileage: number | null;
    haulRate: number | null;
    flags: string[];
  }
  const proposals: Proposal[] = [];
  for (const name of transChargeNames) {
    const flags: string[] = [];
    const hit = resolver.resolve(name);
    const src = hit?.sourceId ? (sourceById.get(hit.sourceId) ?? null) : null;
    if (hit && hit.siteId !== siteId) flags.push(`resolves to ANOTHER site (${hit.siteId})`);
    if (!src && hit?.sourceId) flags.push('resolved id not a Woodland source row');
    const a = woodlandPrimary(tableA, name);
    const b = woodlandPrimary(tableB, name);
    const mileage = a?.mileage ?? b?.mileage ?? null;
    const haulRate = a?.haulRate ?? b?.haulRate ?? null;
    if (a && b && a.mileage !== b.mileage)
      flags.push(`mileage disagrees between tables (${a.mileage} vs ${b.mileage})`);
    if (!a && !b) flags.push('NO DR3 Woodland row in Mileage_Table');
    if (src?.is_trans_charge) flags.push('already flagged');
    proposals.push({
      workbookName: name,
      sourceId: src?.id ?? null,
      sourceName: src?.name ?? null,
      mileage,
      haulRate,
      flags,
    });
  }

  const matched = proposals.filter((p) => p.sourceId && p.mileage !== null && p.flags.length === 0);
  const flagged = proposals.filter((p) => p.sourceId && (p.mileage === null || p.flags.length > 0));
  const unmatched = proposals.filter((p) => !p.sourceId);

  console.log(`\n== BO-4 staging proposal — ${fileName} ==`);
  console.log(
    `trans-charge names in workbook: ${transChargeNames.length} · clean: ${matched.length} · flagged: ${flagged.length} · unmatched: ${unmatched.length}\n`,
  );
  const line = (p: Proposal) =>
    `  ${p.workbookName}  →  ${p.sourceName ?? 'NO SOURCE MATCH'}` +
    `  · mileage ${p.mileage ?? '—'} · rate $${p.haulRate ?? '—'}` +
    (p.flags.length ? `  ⚠ ${p.flags.join('; ')}` : '');
  console.log('── CLEAN (would apply) ──');
  matched.forEach((p) => console.log(line(p)));
  console.log('\n── FLAGGED (needs a call) ──');
  flagged.forEach((p) => console.log(line(p)));
  console.log('\n── UNMATCHED in sources (needs a call) ──');
  unmatched.forEach((p) => console.log(line(p)));

  if (MODE === 'stage') {
    console.log(
      '\nSTAGE mode — nothing written. Review, then re-run with --apply --i-reviewed-the-stage.',
    );
    return;
  }

  // ── APPLY: clean rows only, one audit row per write ───────────────────────
  const bill = await prisma.user.findFirst({
    where: { email: BILL_EMAIL, deleted_at: null },
    select: { id: true },
  });
  if (!bill) throw new Error('no Bill user row');
  let applied = 0;
  for (const p of matched) {
    await prisma.$transaction(async (tx) => {
      const before = sourceById.get(p.sourceId!)!;
      await tx.auditLog.create({
        data: {
          actor_user_id: bill.id,
          action: 'update',
          table_name: 'sources',
          row_id: p.sourceId!,
          before: {
            is_trans_charge: before.is_trans_charge,
            canonical_mileage: before.canonical_mileage,
          },
          after: { is_trans_charge: true, canonical_mileage: p.mileage },
          ip: null,
          user_agent: 'one-off/bo4-workbook-classification',
        },
      });
      await tx.source.update({
        where: { id: p.sourceId! },
        data: { is_trans_charge: true, canonical_mileage: p.mileage },
      });
    });
    applied += 1;
  }
  console.log(`\nAPPLY complete — ${applied} sources classified. Flagged/unmatched untouched.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
