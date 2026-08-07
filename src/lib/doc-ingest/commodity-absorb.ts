// ADR-0080 Phase 2 — reading the commodity audit tracker and STAGING the rows.
//
// The direct precedent is `terex-absorb.ts` and this file mirrors it closely on
// purpose. The one place it deliberately DIVERGES is the identity of a row, and
// the reason is in the schema: `doc_terex_maintenance_rows` is unique on
// `(version, sheet_name, row_index)`, but `doc_commodity_audit_rows` is unique on
// `(version, sheet_name, stream_label, month_label)`. That is the right key for
// this document — a sheet row carries SEVEN streams side by side, so `row_index`
// identifies twelve different facts at once and could never be an identity here.
// Every "have we already decided about this row?" lookup below therefore keys on
// the stream+month pair, not on the row number.
//
// ── Why staging, when this document has no money ────────────────────────────
// `absorb.ts` is where that decision is stated in full. In short: the reason is
// NOT money (there is none anywhere in this workbook) but that a newly-understood
// layout must not become fact on its own say-so.
//
// ── Every sheet is tried; a sheet that refuses does not sink the document ───
// Same discipline as the trailer absorber. The 2026 sheet has 7 stream blocks and
// the 2025 sheet has 6, and a third sheet arriving next year that is a summary
// rather than a matrix must be REPORTED as declined, not silently absorbed and
// not allowed to make the other two unreadable.

import type { Prisma, PrismaClient } from '@prisma/client';
import { extractCommodityAuditRows, type CommodityExtractResult } from './commodity-extract';
import { toCell } from './trailer-absorb';
import type { Cell } from './trailer-extract';

/**
 * Columns scanned per row.
 *
 * The live 2026 sheet is 57 wide and its last stream block starts at column 50,
 * so its final "Date" column is 56. The margin absorbs one more block; the
 * extractor DETECTS blocks rather than counting them off, so a wider file loses
 * only the columns past this bound — and it loses them as a missing block the
 * describe function names, not as a silently shifted column.
 */
const MAX_COLS = 72;

export interface CommodityWorkbookResult {
  sheetNames: string[];
  /** One per sheet, in workbook order. A refusing sheet is present with `failure`. */
  perSheet: CommodityExtractResult[];
  totalRows: number;
}

/** Read every sheet of a commodity tracker. Never throws for a refusing sheet. */
export async function extractCommodityFromWorkbook(
  bytes: Uint8Array,
): Promise<CommodityWorkbookResult> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  type ExcelBuffer = Parameters<typeof workbook.xlsx.load>[0];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await workbook.xlsx.load(view as unknown as ExcelBuffer);

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

  const perSheet: CommodityExtractResult[] = [];
  for (const h of handles) {
    const cells: Cell[][] = [];
    for (let r = 1; r <= h.rowCount; r += 1) {
      const row: Cell[] = [];
      for (let c = 1; c <= MAX_COLS; c += 1) row.push(toCell(h.get(r, c)));
      cells.push(row);
    }
    perSheet.push(extractCommodityAuditRows(h.name, cells));
  }

  return {
    sheetNames,
    perSheet,
    totalRows: perSheet.reduce((n, s) => n + s.rows.length, 0),
  };
}

export interface StageCommodityResult {
  staged: number;
  /**
   * Rows dropped because another row in the SAME sheet already claimed their
   * `(stream_label, month_label)` identity.
   *
   * This can only happen when two stream blocks carry the same banner — most
   * plausibly two blocks whose merged banner cell was empty, so both read as ''.
   * The unique index would reject the second one as a hard P2002 and take the
   * whole absorption down with it; dropping it keeps the other 83 rows, but a
   * DROP THAT NOBODY IS TOLD ABOUT is the silent-zero class this pipeline exists
   * to stop, so the count and the labels come back to the caller and are recorded
   * in the audit row.
   */
  collisions: string[];
}

/**
 * Replace this VERSION's staged rows with the extracted set.
 *
 * CONFIRMED and DISCARDED rows are never touched. A re-absorption of the same
 * revision refreshes what is waiting for a decision; it does not un-accept a
 * coverage claim somebody already accepted, and it does not resurrect a batch
 * somebody discarded.
 */
export async function stageCommodityRows(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    sourceId: string;
    versionId: string;
    siteId: string;
    perSheet: CommodityExtractResult[];
    now: Date;
  },
): Promise<StageCommodityResult> {
  await tx.docCommodityAuditRow.deleteMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
  });

  const already = await tx.docCommodityAuditRow.findMany({
    where: {
      doc_source_version_id: args.versionId,
      status: { in: ['confirmed', 'discarded'] },
    },
    select: { sheet_name: true, stream_label: true, month_label: true },
  });
  // Keyed on the UNIQUE tuple, not on `row_index` — see the header.
  const decided = new Set(
    already.map((r) => `${r.sheet_name}|${r.stream_label}|${r.month_label}`),
  );

  const claimed = new Set<string>();
  const collisions: string[] = [];
  const data: Prisma.DocCommodityAuditRowCreateManyInput[] = [];

  for (const sheet of args.perSheet) {
    for (const r of sheet.rows) {
      const key = `${sheet.sheetName}|${r.streamLabel}|${r.monthLabel}`;
      if (decided.has(key)) continue;
      if (claimed.has(key)) {
        collisions.push(key);
        continue;
      }
      claimed.add(key);
      data.push({
        doc_source_id: args.sourceId,
        doc_source_version_id: args.versionId,
        site_id: args.siteId,
        sheet_name: sheet.sheetName,
        sheet_year: sheet.year,
        stream_group: r.streamGroup,
        stream_label: r.streamLabel,
        month_label: r.monthLabel,
        month_number: r.monthNumber,
        audited: r.audited,
        initials: r.initials,
        // A date only where the cell held a real one. The pair is preserved: the
        // raw text is ALWAYS what the cell said, including the literal "working"
        // and including '' for a cell that existed and was blank.
        audit_date: r.auditDateISO === null ? null : new Date(`${r.auditDateISO}T00:00:00.000Z`),
        audit_date_raw: r.auditDateRaw,
        second_audit: r.secondAudit,
        second_initials: r.secondInitials,
        second_audit_date:
          r.secondAuditDateISO === null ? null : new Date(`${r.secondAuditDateISO}T00:00:00.000Z`),
        second_audit_date_raw: r.secondAuditDateRaw,
        row_index: r.rowIndex,
        status: 'staged' as const,
        absorbed_at: args.now,
      });
    }
  }

  if (data.length === 0) return { staged: 0, collisions };
  const created = await tx.docCommodityAuditRow.createMany({ data });
  return { staged: created.count, collisions };
}

/**
 * A human-readable account of what each sheet actually held.
 *
 * This is what the LOUD ZERO says instead of "the document was empty". It names
 * each sheet, its banner year, the header row that was found, the stream labels
 * that were found, and the row count — or, for a sheet that refused, the
 * extractor's own reason verbatim.
 */
export function describeCommoditySheets(perSheet: CommodityExtractResult[]): string {
  if (perSheet.length === 0) return 'The workbook contains no sheets.';
  return perSheet
    .map((s) => {
      if (s.failure !== null) return `"${s.sheetName}": REFUSED — ${s.failure.message}`;
      const labels = s.streams.map((b) => b.label || '(unlabelled)').join(', ') || '(none)';
      return (
        `"${s.sheetName}" (year ${s.year ?? 'unreadable'}): header row ` +
        `${s.headerRowIndex ?? 'not found'}, ${s.streams.length} stream(s) [${labels}], ` +
        `${s.rows.length} month row(s).`
      );
    })
    .join(' ');
}
