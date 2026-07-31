// ADR-0069 Amendment 2 — reading the TEREX workbook and STAGING the rows.
//
// Staged, not written-and-done: this document carries money, so absorption ends
// with rows a human has not yet accepted. See `terex-extract.ts` for why the
// cross-sheet de-duplication is the difference between $77,067.94 and
// $154,135.88.

import type { Prisma, PrismaClient } from '@prisma/client';
import { extractTerexRows, type TerexExtractResult } from './terex-extract';
import { toCell } from './trailer-absorb';
import type { Cell } from './trailer-extract';

/** Columns scanned per row. The logs use 10; OVERVIEW2026 is 57 wide. */
const MAX_COLS = 24;

/** Read every sheet, then let the extractor decide which are maintenance logs. */
export async function extractTerexFromWorkbook(bytes: Uint8Array): Promise<{
  sheetNames: string[];
  result: TerexExtractResult;
}> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  type ExcelBuffer = Parameters<typeof workbook.xlsx.load>[0];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await workbook.xlsx.load(view as unknown as ExcelBuffer);

  const collected: { name: string; cells: Cell[][] }[] = [];
  const sheetNames: string[] = [];
  const handles: { name: string; rowCount: number; get: (r: number, c: number) => unknown }[] = [];
  workbook.eachSheet((ws) => {
    sheetNames.push(ws.name);
    handles.push({
      name: ws.name,
      rowCount: ws.rowCount,
      get: (r, c) => ws.getRow(r).getCell(c).value,
    });
  });

  for (const h of handles) {
    const cells: Cell[][] = [];
    for (let r = 1; r <= h.rowCount; r += 1) {
      const row: Cell[] = [];
      for (let c = 1; c <= MAX_COLS; c += 1) row.push(toCell(h.get(r, c)));
      cells.push(row);
    }
    collected.push({ name: h.name, cells });
  }

  return { sheetNames, result: extractTerexRows(collected) };
}

/**
 * Replace this VERSION's staged rows with the extracted set.
 *
 * CONFIRMED rows are never touched. A re-absorption of the same revision
 * refreshes what is waiting for a decision; it does not un-accept money somebody
 * already accepted, and it does not resurrect a batch somebody discarded.
 */
export async function stageTerexRows(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    sourceId: string;
    versionId: string;
    siteId: string;
    result: TerexExtractResult;
    now: Date;
  },
): Promise<number> {
  await tx.docTerexMaintenanceRow.deleteMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
  });

  const already = await tx.docTerexMaintenanceRow.findMany({
    where: {
      doc_source_version_id: args.versionId,
      status: { in: ['confirmed', 'discarded'] },
    },
    select: { sheet_name: true, row_index: true },
  });
  const decided = new Set(already.map((r) => `${r.sheet_name}|${r.row_index}`));

  const data = args.result.rows
    .filter((r) => !decided.has(`${r.sheetName}|${r.rowIndex}`))
    .map((r) => ({
      doc_source_id: args.sourceId,
      doc_source_version_id: args.versionId,
      site_id: args.siteId,
      sheet_name: r.sheetName,
      row_index: r.rowIndex,
      event_date: r.eventDate === null ? null : new Date(`${r.eventDate}T00:00:00.000Z`),
      event_date_raw: r.eventDateRaw,
      time_raw: r.timeRaw,
      issue: r.issue,
      measures_taken: r.measuresTaken,
      estimated_time_cost: r.estimatedTimeCost,
      notes: r.notes,
      estimated_cost: r.estimatedCost,
      actual_repair_cost: r.actualRepairCost,
      amount_credited: r.amountCredited,
      dedup_key: r.dedupKey,
      status: 'staged' as const,
      absorbed_at: args.now,
    }));

  if (data.length === 0) return 0;
  const created = await tx.docTerexMaintenanceRow.createMany({ data });
  return created.count;
}

/** A human-readable account of which sheets were used and which were passed over. */
export function describeTerexSheets(result: TerexExtractResult): string {
  const logs = result.sheets.filter((s) => s.skipped === null);
  const skipped = result.sheets.filter((s) => s.skipped !== null);
  const parts = [
    `${logs.length} maintenance log sheet(s) read: ${logs.map((s) => `"${s.sheetName}" (${s.eventsFound} event(s))`).join(', ') || '(none)'}.`,
  ];
  if (result.duplicatesRemoved > 0) {
    parts.push(
      `${result.duplicatesRemoved} duplicate event(s) removed — the same repair appearing more than once ` +
        `(${result.duplicateSources.join(', ')}). Counting them would have inflated the money total.`,
    );
  }
  if (skipped.length > 0) {
    parts.push(
      `${skipped.length} sheet(s) were NOT maintenance logs and were left alone: ` +
        `${skipped.map((s) => `"${s.sheetName}"`).join(', ')}.`,
    );
  }
  return parts.join(' ');
}
