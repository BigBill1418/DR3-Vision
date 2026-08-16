// ADR-0104 §D4 — reading the invoices-tracking workbook and STAGING the rows.
//
// Every sheet is tried; a sheet that refuses does not sink the document. Here
// that discipline is load-bearing rather than defensive: two of the five sheets
// are STOCKTON and are refused BY DESIGN, and a third (`Sheet1`) has no header.
// A workbook where three of five sheets decline must still absorb the two that
// do — and must say, in words, why the other three did not.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  extractFacilityExpenseRows,
  type FacilityExpenseExtractResult,
  type FacilityExpenseSiteScope,
} from './facility-expense-extract';
import { toCell } from './trailer-absorb';
import type { Cell } from './trailer-extract';

/** Columns scanned per row. The live sheets use 14; the margin absorbs growth. */
const MAX_COLS = 24;

export interface FacilityExpenseWorkbookResult {
  sheetNames: string[];
  /** One per sheet, in workbook order. A refusing sheet is present with `failure`. */
  perSheet: FacilityExpenseExtractResult[];
  totalRows: number;
}

/** Read every sheet of an expense workbook. Never throws for a refusing sheet. */
export async function extractFacilityExpensesFromWorkbook(
  bytes: Uint8Array,
  scope: FacilityExpenseSiteScope,
): Promise<FacilityExpenseWorkbookResult> {
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

  const perSheet: FacilityExpenseExtractResult[] = [];
  for (const h of handles) {
    const cells: Cell[][] = [];
    for (let r = 1; r <= h.rowCount; r += 1) {
      const row: Cell[] = [];
      for (let c = 1; c <= MAX_COLS; c += 1) row.push(toCell(h.get(r, c)));
      cells.push(row);
    }
    perSheet.push(extractFacilityExpenseRows(h.name, cells, scope));
  }

  return {
    sheetNames,
    perSheet,
    totalRows: perSheet.reduce((n, s) => n + s.rows.length, 0),
  };
}

export interface StageFacilityExpenseResult {
  staged: number;
  /** `(sheet, row)` pairs a second row in the same batch already claimed. */
  collisions: string[];
}

/**
 * Replace this VERSION's staged rows with the extracted set.
 *
 * CONFIRMED and DISCARDED rows are never touched. A re-absorption refreshes what
 * is waiting for a decision; it does not un-accept money somebody already
 * accepted, and it does not resurrect a batch somebody discarded.
 */
export async function stageFacilityExpenseRows(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    sourceId: string;
    versionId: string;
    siteId: string;
    perSheet: FacilityExpenseExtractResult[];
    now: Date;
  },
): Promise<StageFacilityExpenseResult> {
  await tx.docFacilityExpenseRow.deleteMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
  });

  const already = await tx.docFacilityExpenseRow.findMany({
    where: {
      doc_source_version_id: args.versionId,
      status: { in: ['confirmed', 'discarded'] },
    },
    select: { sheet_name: true, row_index: true },
  });
  const decided = new Set(already.map((r) => `${r.sheet_name}|${r.row_index}`));

  const claimed = new Set<string>();
  const collisions: string[] = [];
  const data: Prisma.DocFacilityExpenseRowCreateManyInput[] = [];

  for (const sheet of args.perSheet) {
    for (const r of sheet.rows) {
      const key = `${sheet.sheetName}|${r.rowIndex}`;
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
        sheet_year: sheet.sheetYear,
        row_index: r.rowIndex,
        present_on_daily_log: r.presentOnDailyLog,
        receipt_raw: r.receiptRaw,
        invoice_date:
          r.invoiceDateISO === null ? null : new Date(`${r.invoiceDateISO}T00:00:00.000Z`),
        invoice_date_raw: r.invoiceDateRaw,
        invoice_month_label: r.invoiceMonthLabel,
        invoice_day: r.invoiceDay,
        amount: r.amount,
        credit_amount: r.creditAmount,
        category_raw: r.categoryRaw,
        category_norm: r.categoryNorm,
        invoice_number: r.invoiceNumber,
        notes: r.notes,
        machine_id_raw: r.machineIdRaw,
        day_raw: r.dayRaw,
        commodity_raw: r.commodityRaw,
        haul_ref: r.haulRef,
        gallons: r.gallons,
        status: 'staged' as const,
        absorbed_at: args.now,
      });
    }
  }

  if (data.length === 0) return { staged: 0, collisions };
  const created = await tx.docFacilityExpenseRow.createMany({ data });
  return { staged: created.count, collisions };
}

/**
 * A human-readable account of what each sheet actually held.
 *
 * This is what the LOUD ZERO says instead of "the document was empty", and it is
 * also what makes a PARTIAL read visible on a successful absorption — a workbook
 * where three of five sheets declined must not look identical to one where all
 * five were read.
 */
export function describeFacilityExpenseSheets(perSheet: FacilityExpenseExtractResult[]): string {
  if (perSheet.length === 0) return 'The workbook contains no sheets.';
  return perSheet
    .map((s) => {
      if (s.failure !== null) return `"${s.sheetName}": REFUSED (${s.failure.kind}) — ${s.failure.message}`;
      return (
        `"${s.sheetName}" (year ${s.sheetYear ?? 'unreadable'}): header row ${s.headerRowIndex}, ` +
        `${s.rows.length} expense row(s) totalling ` +
        `${s.totals.amount.toFixed(2)} with ${s.totals.creditAmount.toFixed(2)} credited; ` +
        `${s.bannerRows} month banner(s), ${s.subtotalRows} subtotal row(s) and ` +
        `${s.repeatedHeaderRows} repeated header row(s) were recognised and skipped.`
      );
    })
    .join(' ');
}
