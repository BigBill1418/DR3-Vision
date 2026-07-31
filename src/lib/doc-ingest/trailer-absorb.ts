// ADR-0069 Amendment 1 — reading a trailer workbook and writing the typed rows.
//
// The exceljs adapter and the DB write live here so `absorb.ts` keeps one shape:
// gate, read bytes, dispatch by kind, record the outcome.
//
// ── Every sheet is tried; a sheet that refuses does not sink the document ───
// The live file has one sheet, but a yard list that grows a second tab (a new
// year, an archive) must not become unabsorbable because the extra tab is a
// summary. Sheets that refuse are REPORTED — their reasons are carried up so a
// zero-row outcome can say which sheets it tried and why each declined, rather
// than reporting an empty document.

import type { Prisma, PrismaClient } from '@prisma/client';
import { extractTrailerRows, type Cell, type TrailerExtractResult } from './trailer-extract';

/** Columns scanned per row. The live sheet uses 9; the margin absorbs growth. */
const MAX_COLS = 24;

/**
 * Reduce one exceljs cell value to the three readings the extractor needs.
 *
 * The formula case matters: `Days in Yard` is a shared formula, and exceljs
 * returns `{ result, sharedFormula }`. Reading `.text` on that yields the formula
 * object stringified, so the cached `result` is taken explicitly. An error cell
 * (`{ error: '#VALUE!' }` — the live file has one on row 1) reads as EMPTY rather
 * than as the literal text "#VALUE!", which would otherwise look like a header.
 */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return { text: '', num: null, date: null };
  if (v instanceof Date) {
    const iso = v.toISOString().slice(0, 10);
    return { text: iso, num: null, date: iso };
  }
  if (typeof v === 'number') return { text: String(v), num: v, date: null };
  if (typeof v === 'boolean') return { text: String(v), num: null, date: null };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) return { text: '', num: null, date: null };
    if ('result' in o) return toCell(o['result']);
    if ('richText' in o) {
      const t = ((o['richText'] as { text: string }[] | undefined) ?? [])
        .map((x) => x.text)
        .join('');
      return { text: t.trim(), num: null, date: null };
    }
    if ('text' in o) return { text: String(o['text'] ?? '').trim(), num: null, date: null };
    if ('hyperlink' in o) return { text: String(o['text'] ?? '').trim(), num: null, date: null };
    return { text: '', num: null, date: null };
  }
  const t = String(v).trim();
  return { text: t, num: null, date: null };
}

export interface TrailerWorkbookResult {
  sheetNames: string[];
  /** One per sheet, in workbook order. */
  perSheet: TrailerExtractResult[];
  totalRows: number;
}

/** Read every sheet of a trailer workbook. Never throws for a refusing sheet. */
export async function extractTrailersFromWorkbook(
  bytes: Uint8Array,
): Promise<TrailerWorkbookResult> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  type ExcelBuffer = Parameters<typeof workbook.xlsx.load>[0];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await workbook.xlsx.load(view as unknown as ExcelBuffer);

  const sheetNames: string[] = [];
  const perSheet: TrailerExtractResult[] = [];

  const sheets: { name: string; rowCount: number; get: (r: number, c: number) => unknown }[] = [];
  workbook.eachSheet((ws) => {
    sheetNames.push(ws.name);
    sheets.push({
      name: ws.name,
      rowCount: ws.rowCount,
      get: (r, c) => ws.getRow(r).getCell(c).value,
    });
  });

  for (const sh of sheets) {
    const cells: Cell[][] = [];
    for (let r = 1; r <= sh.rowCount; r += 1) {
      const row: Cell[] = [];
      for (let c = 1; c <= MAX_COLS; c += 1) row.push(toCell(sh.get(r, c)));
      cells.push(row);
    }
    perSheet.push(extractTrailerRows(sh.name, cells));
  }

  return {
    sheetNames,
    perSheet,
    totalRows: perSheet.reduce((n, s) => n + s.rows.length, 0),
  };
}

/**
 * Replace this VERSION's absorbed rows with the extracted set, atomically.
 *
 * Scoped to the version, not the source: a re-run of the same version replaces
 * rather than duplicates, while a NEW version appends a new generation and the
 * previous one stays readable. That is what makes a re-ingest a comparison
 * rather than a destructive overwrite.
 */
export async function writeTrailerRows(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    sourceId: string;
    versionId: string;
    siteId: string;
    perSheet: TrailerExtractResult[];
    now: Date;
  },
): Promise<number> {
  await tx.docTrailerRow.deleteMany({ where: { doc_source_version_id: args.versionId } });

  const data = args.perSheet.flatMap((sheet) =>
    sheet.rows.map((r) => ({
      doc_source_id: args.sourceId,
      doc_source_version_id: args.versionId,
      site_id: args.siteId,
      sheet_name: sheet.sheetName,
      row_index: r.rowIndex,
      entry_date: r.entryDate === null ? null : new Date(`${r.entryDate}T00:00:00.000Z`),
      trailer_no: r.trailerNo,
      material_raw: r.materialRaw,
      weight_lbs: r.weightLbs,
      weight_raw: r.weightRaw,
      driver: r.driver,
      days_in_yard_sheet: r.daysInYardSheet === null ? null : Math.round(r.daysInYardSheet),
      exit_date: r.exitDate === null ? null : new Date(`${r.exitDate}T00:00:00.000Z`),
      exit_raw: r.exitRaw,
      notes: r.notes,
      absorbed_at: args.now,
    })),
  );

  if (data.length === 0) return 0;
  const created = await tx.docTrailerRow.createMany({ data });
  return created.count;
}

/** Why a zero-row trailer absorption produced nothing — per sheet, in words. */
export function describeSheetFailures(perSheet: TrailerExtractResult[]): string {
  if (perSheet.length === 0) return 'The workbook contains no sheets.';
  return perSheet
    .map((s) =>
      s.failure === null
        ? `"${s.sheetName}": ${s.rows.length} row(s).`
        : `"${s.sheetName}": ${s.failure.message}`,
    )
    .join(' ');
}
