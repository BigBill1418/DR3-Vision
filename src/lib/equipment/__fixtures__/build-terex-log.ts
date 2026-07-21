// Sanitized Terex maintenance-log workbook fixtures for the ADR-0048 D3 importer
// tests. Built with exceljs so the suite never needs Janette's real (unavailable,
// uncommittable) file. Reproduces the real file's STRUCTURAL quirks with fabricated
// issue text / costs:
//   - a banner row (col B) above the header row,
//   - a header row whose labels carry trailing asterisks and a leading UNLABELED
//     column A (which holds "example" / year markers),
//   - a literal `example` row (col A = "example") that must be skipped,
//   - month-separator rows (a bare month name in the Date cell),
//   - year-marker rows (a 4-digit year in col A),
//   - real entries with a true Date cell + Issue/Measures/Notes text,
//   - `Actual Repair Cost` / `Amount Credited` money columns,
//   - subtotal (money, no date) and bare-date (date, no content) noise rows,
//   - unrelated sheets ("Maintenance Prices", "diesel", monthly tabs) to skip.

import ExcelJS from 'exceljs';

const HEADER = [
  null, // col A — unlabeled in the real file
  'Date *',
  'Time  *',
  'Issue *',
  'Measures taken *',
  'Estimated repair time/cost',
  'Estimated cost',
  'Notes*',
  'Actual Repair Cost',
  'Amount Credited',
];

/** Known real-entry count of the fixture's "Maintenance Log 2025" sheet. */
export const FIXTURE_LOG_2025_COUNT = 5;
/** Known real-entry count of the fixture's "Maintenance Log 2026" sheet. */
export const FIXTURE_LOG_2026_COUNT = 3;

function setRow(
  ws: ExcelJS.Worksheet,
  rowIndex: number,
  values: (string | number | Date | null)[],
): void {
  const row = ws.getRow(rowIndex);
  values.forEach((v, i) => {
    if (v !== null) row.getCell(i + 1).value = v;
  });
  row.commit();
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function addMaintenanceLogHeader(ws: ExcelJS.Worksheet): void {
  setRow(ws, 1, [null, 'TEREX MACHINE MAINTENANCE LOG']);
  setRow(ws, 2, HEADER);
  // The literal example row (col A = "example") — must be excluded.
  setRow(ws, 3, [
    'example',
    'October     10/9/2024',
    '11:52am',
    'sample dripping oil',
    'called the vendor',
    '2 weeks',
    null,
    'fixed next day',
    null,
    null,
  ]);
}

/**
 * A workbook shaped like Janette's real file: two "Maintenance Log <year>" import
 * targets (5 + 3 real entries) plus four unrelated sheets that must be skipped.
 */
export async function buildTerexWorkbook(): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();

  const s25 = wb.addWorksheet('Maintenance Log 2025');
  addMaintenanceLogHeader(s25);
  setRow(s25, 4, [2024, 'September']); // year marker + month separator
  setRow(s25, 5, [null, 'October']); // month separator
  // 5 real entries:
  setRow(s25, 6, [null, utc(2024, 11, 11), null, 'belt worn', 'replaced belt']); // maintenance, no cost
  setRow(s25, 7, [
    null,
    utc(2024, 11, 21),
    null,
    'shaft broken',
    'new shaft installed',
    null,
    null,
    null,
    4850,
  ]); // repair 485000c
  setRow(s25, 8, [
    null,
    utc(2024, 11, 27),
    null,
    'conveyor edges tearing',
    null,
    null,
    null,
    null,
    1584.66,
  ]); // repair 158466c
  setRow(s25, 9, [null, 'December']); // month separator
  setRow(s25, 10, [null, utc(2025, 1, 5), null, null, null, null, null, 'routine inspection ok']); // maintenance via Notes
  setRow(s25, 11, [null, utc(2025, 1, 9), null, null, null, null, null, null, null, 1200]); // credit-only → maintenance, note
  // noise rows that must NOT become events:
  setRow(s25, 12, [null, null, null, null, null, null, null, null, 9999, 250]); // subtotal (money, no date)
  setRow(s25, 13, [null, utc(2025, 1, 20)]); // bare date, no content

  const s26 = wb.addWorksheet('Maintenance Log 2026');
  addMaintenanceLogHeader(s26);
  setRow(s26, 4, [null, 'February']); // month separator
  // 3 real entries:
  setRow(s26, 5, [
    null,
    utc(2026, 2, 3),
    null,
    'hydraulic leak',
    'hose replaced',
    null,
    null,
    null,
    300,
  ]); // repair 30000c
  setRow(s26, 6, [null, utc(2026, 2, 10), null, 'greased bearings']); // maintenance
  setRow(s26, 7, [
    null,
    utc(2026, 3, 15),
    null,
    null,
    'belt tension adjusted',
    null,
    null,
    'ran fine after',
  ]); // maintenance

  // Unrelated sheets that must be skipped (not maintenance LOGS):
  addSkippableSheets(wb);
  return wb.xlsx.writeBuffer();
}

/** A workbook with NO maintenance-log sheet — the importer must fail loud. */
export async function buildNoLogSheetWorkbook(): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  addSkippableSheets(wb);
  return wb.xlsx.writeBuffer();
}

function addSkippableSheets(wb: ExcelJS.Workbook): void {
  const prices = wb.addWorksheet('Maintenance Prices'); // "Maintenance" but not a LOG
  setRow(prices, 1, ['Part', 'Price']);
  setRow(prices, 2, ['fuel filter', 42.5]);
  const diesel = wb.addWorksheet('diesel');
  setRow(diesel, 1, ['Date', 'Gallons']);
  setRow(diesel, 2, [utc(2026, 1, 2), 120]);
  wb.addWorksheet('Jan 2026'); // monthly operating tab
  wb.addWorksheet('Feb26'); // monthly operating tab (variant spelling)
}
