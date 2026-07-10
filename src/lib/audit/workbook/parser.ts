// ADR-0039 D4 — historical workbook parser (retro-audit ingestion).
//
// Parses a monthly workbook (xlsx/xlsm) into STAGING rows tagged with full
// tab/row/col provenance — never into operational tables. It tolerates the ≥3
// template generations Janette described (Q8: no calculations → calculations
// added → EOD-inventory carryover) by reading structurally rather than assuming
// a single layout.
//
// exceljs choice: the repo had no xlsx library (papaparse is CSV-only); exceljs
// (pure JS, actively maintained, reads xlsm by ignoring the VBA part) was added
// as a dependency. See ADR-0039 post-acceptance notes.
//
// Layout convention (mirrors mission §4 / Addendum B; the real daily-log file
// folds in as follow-up config per Addendum A "do not block P1 on the file"):
//   - Sheet "Summary": row 1 headers
//       figure_key | stored_value | detail_sheet | detail_column | range_first_row | range_last_row
//     Each subsequent row is one Summary figure. A figure that names a detail
//     sheet + range is a SUMMED figure (calc generation); the recompute reads
//     the FULL detail block to catch rows the template's range clipped (§4.1).
//   - Sheet "Inbound": site_name | source_type | units  (source-type rollup, §B1)
//   - Sheet "Outbound": commodity | sub_category | weight_lbs  (commodity × sub-category, §B1)
//   - Sheet "Inventory" (eod_carryover generation only): day ledger.

import ExcelJS from 'exceljs';
import { cellText, cellNumber } from './cells';

export type TemplateGeneration = 'no_calc' | 'calc' | 'eod_carryover' | 'unknown';

export interface CellProvenance {
  tab: string;
  row: number;
  col: string;
}

/** One parsed record with provenance (persisted to `workbook_import_rows`). */
export interface StagingRow {
  tabName: string;
  rowIndex: number;
  colRef: string;
  section: string | null;
  fieldKey: string | null;
  rawValue: string | null;
  numericValue: number | null;
  siteNameRaw: string | null;
  provenance: CellProvenance;
}

export interface SummaryFigure {
  key: string;
  storedValue: number;
  detailSheet: string | null;
  detailColumn: string | null;
  rangeFirstRow: number | null;
  rangeLastRow: number | null;
  provenance: CellProvenance;
}

export interface DetailAmount {
  sheet: string;
  column: string;
  row: number;
  value: number;
  /** True when this row falls OUTSIDE the template's summed range (a candidate drop). */
  outsideRange: boolean;
}

export interface InboundStage {
  siteNameRaw: string;
  sourceType: string;
  units: number;
  provenance: CellProvenance;
}

export interface OutboundStage {
  commodity: string;
  subCategory: string | null;
  weightLbs: number;
  provenance: CellProvenance;
}

export interface ParsedWorkbook {
  templateGeneration: TemplateGeneration;
  sheetCount: number;
  stagingRows: StagingRow[];
  summaryFigures: SummaryFigure[];
  /** Full detail block per Summary figure key (incl. rows outside the template range). */
  detailAmountsByFigure: Map<string, DetailAmount[]>;
  inbound: InboundStage[];
  outbound: OutboundStage[];
}

// ────────────────────────────────────────────────────────────────────────
// Cell helpers
// ────────────────────────────────────────────────────────────────────────

/** 'A' → 1, 'B' → 2, 'AA' → 27. */
export function columnLetterToNumber(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

// ────────────────────────────────────────────────────────────────────────
// Parse
// ────────────────────────────────────────────────────────────────────────

export async function parseWorkbook(
  data: ExcelJS.Buffer | ArrayBuffer | Buffer | Uint8Array,
): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ExcelJS.Buffer);

  const stagingRows: StagingRow[] = [];
  const summaryFigures: SummaryFigure[] = [];
  const detailAmountsByFigure = new Map<string, DetailAmount[]>();
  const inbound: InboundStage[] = [];
  const outbound: OutboundStage[] = [];

  const sheetNames = wb.worksheets.map((w) => w.name);
  const hasInventory = sheetNames.some((n) => n.toLowerCase() === 'inventory');

  const summarySheet = wb.worksheets.find((w) => w.name.toLowerCase() === 'summary');
  if (summarySheet) {
    summarySheet.eachRow((row, rowIndex) => {
      if (rowIndex === 1) return; // header
      const key = cellText(row.getCell(1).value);
      const stored = cellNumber(row.getCell(2).value);
      if (key === null || stored === null) return;
      const detailSheet = cellText(row.getCell(3).value);
      const detailColumn = cellText(row.getCell(4).value);
      const rangeFirstRow = cellNumber(row.getCell(5).value);
      const rangeLastRow = cellNumber(row.getCell(6).value);
      const provenance: CellProvenance = { tab: summarySheet.name, row: rowIndex, col: 'B' };
      summaryFigures.push({
        key,
        storedValue: stored,
        detailSheet: detailSheet ?? null,
        detailColumn: detailColumn ?? null,
        rangeFirstRow: rangeFirstRow ?? null,
        rangeLastRow: rangeLastRow ?? null,
        provenance,
      });
      stagingRows.push({
        tabName: summarySheet.name,
        rowIndex,
        colRef: 'B',
        section: 'summary',
        fieldKey: key,
        rawValue: String(stored),
        numericValue: stored,
        siteNameRaw: null,
        provenance,
      });
    });

    // For each summed figure, read the FULL detail block (from range_first_row
    // down through the last contiguous numeric row) so rows the template's range
    // dropped are still captured for the recompute.
    for (const fig of summaryFigures) {
      if (!fig.detailSheet || !fig.detailColumn || fig.rangeFirstRow === null) continue;
      const ds = wb.worksheets.find((w) => w.name.toLowerCase() === fig.detailSheet!.toLowerCase());
      if (!ds) continue;
      const colNum = columnLetterToNumber(fig.detailColumn);
      const amounts: DetailAmount[] = [];
      const lastScanRow = Math.max(ds.rowCount, fig.rangeLastRow ?? fig.rangeFirstRow);
      let blanks = 0;
      for (let r = fig.rangeFirstRow; r <= lastScanRow && blanks < 5; r++) {
        const v = cellNumber(ds.getRow(r).getCell(colNum).value);
        if (v === null) {
          blanks++;
          continue;
        }
        blanks = 0;
        const outsideRange =
          fig.rangeLastRow !== null && (r < fig.rangeFirstRow || r > fig.rangeLastRow);
        amounts.push({ sheet: ds.name, column: fig.detailColumn, row: r, value: v, outsideRange });
        stagingRows.push({
          tabName: ds.name,
          rowIndex: r,
          colRef: fig.detailColumn,
          section: 'detail',
          fieldKey: fig.key,
          rawValue: String(v),
          numericValue: v,
          siteNameRaw: null,
          provenance: { tab: ds.name, row: r, col: fig.detailColumn },
        });
      }
      detailAmountsByFigure.set(fig.key, amounts);
    }
  }

  const inboundSheet = wb.worksheets.find((w) => w.name.toLowerCase() === 'inbound');
  if (inboundSheet) {
    inboundSheet.eachRow((row, rowIndex) => {
      if (rowIndex === 1) return;
      const siteNameRaw = cellText(row.getCell(1).value);
      const sourceType = cellText(row.getCell(2).value);
      const units = cellNumber(row.getCell(3).value);
      if (siteNameRaw === null || sourceType === null || units === null) return;
      const provenance: CellProvenance = { tab: inboundSheet.name, row: rowIndex, col: 'C' };
      inbound.push({ siteNameRaw, sourceType, units, provenance });
      stagingRows.push({
        tabName: inboundSheet.name,
        rowIndex,
        colRef: 'C',
        section: 'inbound',
        fieldKey: sourceType,
        rawValue: String(units),
        numericValue: units,
        siteNameRaw,
        provenance,
      });
    });
  }

  const outboundSheet = wb.worksheets.find((w) => w.name.toLowerCase() === 'outbound');
  if (outboundSheet) {
    outboundSheet.eachRow((row, rowIndex) => {
      if (rowIndex === 1) return;
      const commodity = cellText(row.getCell(1).value);
      const subCategory = cellText(row.getCell(2).value);
      const weightLbs = cellNumber(row.getCell(3).value);
      if (commodity === null || weightLbs === null) return;
      const provenance: CellProvenance = { tab: outboundSheet.name, row: rowIndex, col: 'C' };
      outbound.push({ commodity, subCategory: subCategory ?? null, weightLbs, provenance });
      stagingRows.push({
        tabName: outboundSheet.name,
        rowIndex,
        colRef: 'C',
        section: 'outbound',
        fieldKey: commodity,
        rawValue: String(weightLbs),
        numericValue: weightLbs,
        siteNameRaw: null,
        provenance,
      });
    });
  }

  // Structural template-generation detection (tolerant of all three shapes).
  const anySummed = summaryFigures.some((f) => f.detailSheet !== null && f.rangeFirstRow !== null);
  const templateGeneration: TemplateGeneration = hasInventory
    ? 'eod_carryover'
    : anySummed
      ? 'calc'
      : summaryFigures.length > 0 || inbound.length > 0 || outbound.length > 0
        ? 'no_calc'
        : 'unknown';

  return {
    templateGeneration,
    sheetCount: wb.worksheets.length,
    stagingRows,
    summaryFigures,
    detailAmountsByFigure,
    inbound,
    outbound,
  };
}
