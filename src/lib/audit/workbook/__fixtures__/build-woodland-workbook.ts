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

function setRow(ws: ExcelJS.Worksheet, rowIndex: number, values: (FixtureCell | Date)[]): void {
  const row = ws.getRow(rowIndex);
  values.forEach((v, i) => {
    if (v !== null && v !== undefined) row.getCell(i + 1).value = v;
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

// ────────────────────────────────────────────────────────────────────────
// §8.2 semantic-extractor bench — a synthetic workbook that mirrors the REAL
// Woodland sheet NAMES + section-label + grid SHAPE, with wholly-invented data
// (never real production numbers). Exercises parser.ts → section-extractors.ts
// end-to-end: classification → per-section extraction → promotion-consumable
// StagingRow payloads → authoritative close balance.
// ────────────────────────────────────────────────────────────────────────

const D = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/**
 * Build a miniature but structurally-faithful Woodland daily-log workbook:
 *   - "June2026 inb trans charges": header row 3 + 2 B2B inbound loads
 *   - "NonProgram": header row 2 + 1 non-program inbound load
 *   - "June26 incentive_unpaid": UNPAID drop-off block (right side) + 1 row
 *   - "June26 Processed": opening balance 1500 + 2 "Day N" close rows
 *   - "Summary": one billing figure
 *   - "DAY1": OUTBOUNDS grid (marker/label/header/data) with a trash shipment
 *   - "DAY6": OUTBOUNDS grid incl. the 9th COTTON block at col 68 + ending-inv
 * All numbers are invented. Month is June 2026.
 */
export async function buildWoodlandDailyLogWorkbook(): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();

  // Inbound WITH trans charge (header row 3, data row 4+).
  const inb = wb.addWorksheet('June2026 inb trans charges');
  setRow(inb, 2, [null, 'INBOUND WITH TRANS CHARGE - Woodland']);
  setRow(inb, 3, [
    'Date',
    'Site',
    'inbound unit #',
    'LBS.  (55 per Unit)',
    'BOL # or Check #',
    'DR3 #',
    'Haul #',
  ]);
  setRow(inb, 4, [D('2026-06-02'), 'Bass Hill Landfill', 50, 2750, null, 4001, 1450]);
  setRow(inb, 5, [D('2026-06-03'), 'Recology Sonoma', 30, 1650, null, 4002, 600]);
  setRow(inb, 6, ['Total']);

  // NonProgram inbound (header row 2).
  const np = wb.addWorksheet('NonProgram');
  setRow(np, 2, [
    'Date',
    'Site',
    'commodity',
    'inbound unit #',
    'LBS.  (55 per Unit)',
    'BOL # or Check #',
    'DR3 #',
    'Haul #',
    'Office Use Only',
    'trans charge',
  ]);
  setRow(np, 3, [
    D('2026-06-04'),
    'Golden Bear',
    'inbound units',
    20,
    1100,
    null,
    4003,
    null,
    null,
    'NP',
  ]);

  // Incentive/Unpaid drop-offs (two side-by-side blocks; unpaid on the right).
  const iu = wb.addWorksheet('June26 incentive_unpaid');
  setRow(iu, 2, [
    null,
    'INBOUND - INCENTIVE DROP OFF',
    ...Array(11).fill(null),
    'UNPAID DROP OFF - Woodland',
  ]);
  const iuHdr: (string | null)[] = Array(20).fill(null);
  iuHdr[0] = 'Date';
  iuHdr[1] = 'Site';
  iuHdr[3] = 'inbound unit #';
  iuHdr[12] = 'Date';
  iuHdr[13] = 'Site';
  iuHdr[15] = 'inbound unit #';
  setRow(iu, 3, iuHdr);
  const iuRow: (string | number | null | Date)[] = Array(20).fill(null);
  iuRow[12] = D('2026-06-05');
  iuRow[13] = 'Unpaid Consumer Drop off';
  iuRow[15] = 8;
  setRow(iu, 4, iuRow);

  // Processed (opening 1500; two Day rows).
  const proc = wb.addWorksheet('June26 Processed');
  setRow(proc, 1, [null, null, 'June 2026 PROCESSED UNITS']);
  setRow(proc, 5, [null, null, null, 1500, 'Program', 0, 'NON']);
  setRow(proc, 7, [
    null,
    null,
    'DAILY TOTAL',
    'DAILY Program',
    'Daily Non Program',
    'PROGRAM',
    'NON-MRC',
  ]);
  setRow(proc, 8, [
    null,
    null,
    'INBOUND UNITS',
    'STRIPPED UNITS',
    'Stripped Units',
    'INBOUND UNITS',
    'INBOUND UNITS',
    'Sold Units',
    'Landfilled',
  ]);
  setRow(proc, 9, [null, 'Day 1', 100, 120, 5, 100, null, null, null, 'M-100001']);
  setRow(proc, 10, [null, 'Day 2', 90, 110, 0, 90, null, null, null, 'M-100002']);

  // Summary (billing grid).
  const sum = wb.addWorksheet('Summary');
  setRow(sum, 3, [null, 'Woodland-  Summary MID-MONTH']);
  setRow(sum, 9, [null, 'Woodland Processed', 12345]);

  // DAY1 outbound grid (marker row 50, labels 51, headers 52, data 53).
  buildDayGrid(wb, 'DAY1', 50, false, '2026-06-01', 1490);
  // DAY6 with the 9th cotton block + a later ending inventory (the close).
  buildDayGrid(wb, 'DAY6', 50, true, '2026-06-06', 1523);

  return wb.xlsx.writeBuffer();
}

/** Lay an OUTBOUNDS grid onto a DAY sheet (optionally with the cotton block). */
function buildDayGrid(
  wb: ExcelJS.Workbook,
  name: string,
  markerRow: number,
  withCotton: boolean,
  isoDate: string,
  endingInventory: number,
): void {
  const ws = wb.addWorksheet(name);
  // Summary box (Starting/Ending inventory) near the top.
  setRow(ws, 2, [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'Starting inventory',
    endingInventory - 20,
  ]);
  setRow(ws, 38, [
    null,
    null,
    null,
    'Ending inventory',
    endingInventory,
    null,
    null,
    'INBOUND',
    111,
    null,
    null,
    'Processed',
    95,
  ]);

  setRow(ws, markerRow, [null, null, 'OUTBOUNDS']);
  const labelRow: (string | null)[] = [];
  const headerRow: (string | null)[] = [];
  const dataRow: (string | number | Date | null)[] = [];
  const standard = ['TRASH', 'METAL', 'WOOD', 'FOAM', 'TOPPERS', 'CARDBOARD', 'PLASTIC', 'SHODDY'];
  const commodities = [
    'trash',
    'metal',
    'wood',
    'foam',
    'toppers',
    'cardboard',
    'plastic',
    'shoddy',
  ];
  const fields = ['Date', 'Site', 'Commodity', 'Weight', 'BOL#', 'DR3#', 'Haul#'];
  standard.forEach((label, i) => {
    const start = 3 + 8 * i; // 1-based col
    labelRow[start - 1] = label;
    fields.forEach((f, k) => (headerRow[start - 1 + k] = f));
    // One shipment per block.
    dataRow[start - 1] = D(isoDate);
    dataRow[start] = `Buyer ${label}`;
    dataRow[start + 1] = commodities[i]!;
    dataRow[start + 2] = 1000 + i * 100; // weight
    dataRow[start + 4] = 5000 + i; // DR3
    dataRow[start + 5] = `M-20${i}`; // ticket
  });
  if (withCotton) {
    const start = 68;
    labelRow[start - 1] = 'COTTON';
    [...fields, 'revenue'].forEach((f, k) => (headerRow[start - 1 + k] = f));
    dataRow[start - 1] = D(isoDate);
    dataRow[start] = 'Buyer COTTON';
    dataRow[start + 1] = 'cotton';
    dataRow[start + 2] = 900;
    dataRow[start + 5] = 'M-209';
  }
  setRow(ws, markerRow + 1, labelRow);
  setRow(ws, markerRow + 2, headerRow);
  setRow(ws, markerRow + 3, dataRow);
}
