// Synthetic Woodland-workbook fixtures for the ADR-0048/0049 section-resolver +
// day-sheet-layout tests. Builds exceljs sheets from the §5 sample-rows fixture
// (tests/fixtures/adr-0048/sample-rows.json) so the suite exercises the resolver
// against REAL captured bytes without needing the (unavailable) full workbook.
//
// Each fixture entry has { sheet, header_row, columns?, sample_rows }. We place
// `columns` (when present) at `header_row`, then the `sample_rows` immediately
// below. Entries without a `columns` array (e.g. `variables`) write their sample
// rows starting at `header_row` — matching how those tabs carry data directly.

import ExcelJS from 'exceljs';

export type FixtureCell = string | number | null;

export interface FixtureEntry {
  sheet: string;
  header_row: number;
  columns?: string[];
  sample_rows: FixtureCell[][];
  label?: string;
  extra_cols?: string;
}

export type SampleRowsFixture = Record<string, FixtureEntry>;

function setRow(ws: ExcelJS.Worksheet, rowIndex: number, values: FixtureCell[]): void {
  const row = ws.getRow(rowIndex);
  values.forEach((v, i) => {
    if (v !== null) row.getCell(i + 1).value = v;
  });
  row.commit();
}

/** Add one sheet built from a fixture entry to `wb`, using an optional name override. */
export function addFixtureSheet(
  wb: ExcelJS.Workbook,
  entry: FixtureEntry,
  nameOverride?: string,
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(nameOverride ?? entry.sheet);
  let cursor = entry.header_row;
  if (entry.columns && entry.columns.length > 0) {
    setRow(ws, cursor, entry.columns);
    cursor += 1;
  }
  for (const sampleRow of entry.sample_rows) {
    setRow(ws, cursor, sampleRow);
    cursor += 1;
  }
  return ws;
}

/** Pull a required fixture entry by key (throws on a missing key — a broken fixture). */
export function pick(fx: SampleRowsFixture, key: string): FixtureEntry {
  const entry = fx[key];
  if (!entry) throw new Error(`sample-rows fixture missing entry: ${key}`);
  return entry;
}

/** A junk sheet with a non-catalogued shape — must resolve to 'unknown'. */
export function addJunkSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  setRow(ws, 1, ['alpha', 'beta', 'gamma']);
  setRow(ws, 2, [1, 2, 3]);
  return ws;
}

/** A bare DAY sheet (name only) — resolver classifies these by name alone. */
export function addDaySheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  // A minimal row-51 grid header so the sheet is non-empty; resolution is by name.
  setRow(ws, 2, ['Starting inventory', 1423]);
  return ws;
}

/**
 * Build a workbook containing every §5 Woodland fixture sheet (June + July),
 * an unrecognized junk sheet, and a bare DAY6 sheet — the classification bench.
 */
export async function buildWoodlandClassificationWorkbook(
  fx: SampleRowsFixture,
): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  // Category tabs + simple-shape tabs from real fixture bytes.
  addFixtureSheet(wb, pick(fx, 'june_inb_trans')); // "June2026 inb trans charges"
  addFixtureSheet(wb, pick(fx, 'july_inb_trans')); // "inb trans charges" (July, prefix dropped)
  addFixtureSheet(wb, pick(fx, 'june_nonprogram')); // "NonProgram"
  addFixtureSheet(wb, pick(fx, 'june_fuel')); // "Fuel"
  addFixtureSheet(wb, pick(fx, 'june_variables')); // "variables"
  // DAY sheet (name-resolved) + an unrecognized shape.
  addDaySheet(wb, 'DAY6');
  addJunkSheet(wb, 'ScratchPad');
  return wb.xlsx.writeBuffer();
}

/** Build a single-sheet workbook from one fixture entry (for round-trip reads). */
export async function buildSingleSheetWorkbook(entry: FixtureEntry): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  addFixtureSheet(wb, entry);
  return wb.xlsx.writeBuffer();
}
