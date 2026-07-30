// ADR-0049 — fixture workbook builder (mock-first discipline).
//
// Produces REAL .xlsx bytes with exceljs so the whole engine — the shared
// ADR-0039/0048 `parseWorkbook` + the daily-production adapter — runs end-to-end
// without the tenant.
//
// SHAPE (changed 2026-07-30): this used to build a `Daily` sheet with invented
// columns A–G that no Woodland workbook has ever had, and the adapter was written
// to match it. A fixture whose layout cannot occur in production tests nothing
// about production — it only makes a broken adapter look green. This builder now
// mirrors the REAL file's structure, so the mock and the live path exercise the
// same resolution:
//   - "June26 Processed" — the daily close. Col B "Day N", C daily total,
//     D stripped program, E stripped non-program, F/G inbound split, J material
//     ticket; opening balances in the row-5 band. This is the sheet the semantic
//     extractor turns into `daily_close` staging rows.
//   - "DAY<n>" — one per production day, carrying the dated per-day INBOUND grid
//     (the parser derives the workbook month from these dated rows, and without
//     one the Processed rows are never built) plus the labelled "Saved" cell.
//
// There are deliberately NO employees / processors columns: the real Processed
// sheet has none. `processed_units_daily.employees_count` / `processors_count`
// are Vision-captured fields the workbook does not carry, and the fixture must
// not pretend otherwise.

import ExcelJS from 'exceljs';

export interface FixtureDailyRow {
  /** 'YYYY-MM-DD'. All rows must fall in one month (a workbook is one month). */
  date: string;
  /** null → the Processed sheet's col D is blank: mid-edit, skipped + counted. */
  strippedProgram: number | null;
  /** null → col E blank. Also required: a blank one is skipped, never zeroed. */
  strippedNonProgram: number | null;
  materialTicket?: string;
  /** The DAY sheet's labelled "Saved" cell (ADR-0037 §A.2). */
  savedUnits?: number;
  /** Inbound units on this day's DAY sheet (dates the workbook; default 10). */
  inboundUnits?: number;
  /** Source name on the day's inbound row (default 'Bass Hill Landfill'). */
  inboundSite?: string;
}

export interface FixtureWorkbookSpec {
  daily: FixtureDailyRow[];
  /** Opening program balance on the Processed sheet (default 1500). */
  openingProgram?: number;
  /**
   * 'YYYY-MM' for a spec with no daily rows (an empty new-month file). Ignored
   * when `daily` is non-empty — the month comes from the rows themselves.
   */
  month?: string;
  /** Add a billing Summary sheet (default true). */
  summary?: { key: string; value: number }[];
  /**
   * Drop the Processed sheet entirely — models Kelsey removing/renaming the tab
   * past recognition. The workbook still has Woodland content (DAY sheets), so
   * this is a LAYOUT failure, not an empty month.
   */
  omitProcessedSheet?: boolean;
  /**
   * Override the Processed tab name. A name the section resolver cannot match
   * (and with no row-2 section label) classifies as 'unknown' and is never
   * scanned — the other half of the layout-drift case.
   */
  processedSheetNameOverride?: string;
  /**
   * Drop the DAY sheets. The parser derives the workbook MONTH from a dated DAY
   * inbound row; without one it cannot date "Day N" and never builds the
   * daily-close rows. A real fragility, and it must fail loudly rather than
   * report an empty month.
   */
  omitDaySheets?: boolean;
}

/** A representative June-Woodland fixture: three clean days + one mid-edit day. */
export const DEFAULT_FIXTURE_SPEC: FixtureWorkbookSpec = {
  daily: [
    {
      date: '2026-06-01',
      strippedProgram: 150,
      strippedNonProgram: 25,
      materialTicket: 'M-000401',
    },
    {
      date: '2026-06-02',
      strippedProgram: 175,
      strippedNonProgram: 12,
      materialTicket: 'M-000402',
    },
    {
      date: '2026-06-03',
      strippedProgram: 160,
      strippedNonProgram: 0,
      materialTicket: 'M-000403',
    },
    // Mid-edit: the day is on the sheet and non-program is entered, but the
    // program figure is not yet — skipped + counted, retried next poll (D11).
    { date: '2026-06-04', strippedProgram: null, strippedNonProgram: 0 },
  ],
  summary: [{ key: 'processed_units_total', value: 485 }],
};

function setRow(
  ws: ExcelJS.Worksheet,
  rowIndex: number,
  values: (string | number | Date | null)[],
): void {
  const row = ws.getRow(rowIndex);
  values.forEach((v, i) => {
    if (v !== null && v !== undefined) row.getCell(i + 1).value = v;
  });
  row.commit();
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * 'June26 Processed' — the real tab-naming shape. The section resolver's name
 * fallback strips a leading MONTH-NAME(+year) token; a numeric prefix
 * ('202606 Processed') does not strip and the sheet resolves to 'unknown'.
 */
function processedSheetName(month: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1];
  if (!name) throw new Error(`fixture spec has an invalid month: ${month}`);
  return `${name}${month.slice(2, 4)} Processed`;
}

function monthOf(spec: FixtureWorkbookSpec): string {
  const first = spec.daily[0];
  if (!first) return spec.month ?? '2026-06';
  const month = first.date.slice(0, 7);
  const stray = spec.daily.find((r) => r.date.slice(0, 7) !== month);
  if (stray) {
    throw new Error(
      `fixture spec spans multiple months (${month} and ${stray.date.slice(0, 7)}) — a workbook is one month`,
    );
  }
  return month;
}

/**
 * One DAY sheet: the dated per-day INBOUND grid the parser reads (and derives the
 * workbook month from), plus the summary box carrying "Saved".
 */
function addDaySheet(wb: ExcelJS.Workbook, row: FixtureDailyRow): void {
  const day = Number(row.date.slice(8, 10));
  const ws = wb.addWorksheet(`DAY${day}`);
  setRow(ws, 4, [
    null,
    null,
    'Date',
    'Site',
    'commodity',
    'inbound unit #',
    'Outbound Unit #',
    'LBS.  (55 per Unit)',
  ]);
  setRow(ws, 5, [
    null,
    null,
    new Date(`${row.date}T00:00:00.000Z`),
    row.inboundSite ?? 'Bass Hill Landfill',
    'inbound units',
    row.inboundUnits ?? 10,
  ]);
  if (row.savedUnits !== undefined) setRow(ws, 38, [null, null, null, 'Saved', row.savedUnits]);
}

/** The Processed sheet: opening-balance band, header band, one row per `Day N`. */
function addProcessedSheet(wb: ExcelJS.Workbook, spec: FixtureWorkbookSpec, month: string): void {
  const proc = wb.addWorksheet(spec.processedSheetNameOverride ?? processedSheetName(month));
  setRow(proc, 1, [null, null, `${month} PROCESSED UNITS`]);
  setRow(proc, 5, [null, null, null, spec.openingProgram ?? 1500, 'Program', 0, 'NON']);
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
  spec.daily.forEach((r, i) => {
    const inbound = r.inboundUnits ?? 10;
    setRow(proc, 9 + i, [
      null,
      `Day ${Number(r.date.slice(8, 10))}`,
      inbound, // C daily total
      r.strippedProgram, // D stripped program
      r.strippedNonProgram, // E stripped non-program
      inbound, // F program inbound
      0, // G non-program inbound
      null, // H sold
      null, // I landfilled
      r.materialTicket ?? null, // J material ticket
    ]);
  });
}

export async function buildFixtureWorkbookBytes(
  spec: FixtureWorkbookSpec = DEFAULT_FIXTURE_SPEC,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const month = monthOf(spec);

  // Processed — the daily close (semantic type 'processed' via the name fallback).
  if (!spec.omitProcessedSheet) addProcessedSheet(wb, spec, month);

  if (spec.omitDaySheets) {
    // no DAY sheets — the workbook month is underivable
  } else if (spec.daily.length > 0) {
    // One DAY sheet per DATE — a spec may carry two Processed rows for the same
    // day (the conflicting-duplicate case) but a workbook has one DAY<n> tab.
    const seen = new Set<string>();
    for (const r of spec.daily) {
      if (seen.has(r.date)) continue;
      seen.add(r.date);
      addDaySheet(wb, r);
    }
  } else {
    // An empty month still has DAY sheets and inbound loads — the site received
    // mattresses and has processed none yet. Without a DATED inbound row the
    // parser cannot derive the workbook month, which is a DIFFERENT outcome
    // (layout unreadable), so the empty-month fixture must still carry one.
    addDaySheet(wb, { date: `${month}-01`, strippedProgram: null, strippedNonProgram: null });
  }

  const figures = spec.summary ?? [];
  if (figures.length > 0) {
    const sum = wb.addWorksheet('Summary');
    setRow(sum, 3, [null, 'Woodland-  Summary MID-MONTH']);
    figures.forEach((s, i) => setRow(sum, 9 + i, [null, s.key, s.value]));
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
