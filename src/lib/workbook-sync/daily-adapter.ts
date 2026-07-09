// ADR-0049 D12 — daily-production adapter (PARSER-FINALIZATION SEAM).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ LOUD NOTE: this reads the Addendum-B FIXTURE `Daily` sheet layout. The real │
// │ `JUNE 2026 DAILY LOG WOODLAND.xlsm` day layout is finalized once Kelsey's    │
// │ file is in hand (D12). When it lands, THIS FILE is the single place the      │
// │ column mapping changes — the engine, upsert, ledger, transport and tests     │
// │ above/below it stay put. The shared ADR-0048 `parseWorkbook` still runs for  │
// │ staging/provenance (see engine.ts); this adapter derives the per-day         │
// │ operational rows the sync upserts into `processed_units_daily` (D3 target).  │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Daily sheet columns (fixture): A=production_date B=stripped_program
//   C=stripped_non_program D=material_ticket E=employees F=processors G=saved_units
// Required cells (mid-edit guard, D11): production_date + stripped_program. A row
// missing either is returned with `midEdit=true` — the upsert SKIPS + COUNTS it and
// it is retried next poll, with NO alert.

import ExcelJS from 'exceljs';

export interface DailyProductionRow {
  /** 'YYYY-MM-DD' (UTC day key) — the (site, production_date) upsert key. */
  productionDate: string;
  strippedProgram: number;
  strippedNonProgram: number;
  materialTicketNumber: string | null;
  employeesCount: number | null;
  processorsCount: number | null;
  savedUnits: number | null;
}

export interface DailyParseResult {
  rows: DailyProductionRow[];
  /** Rows present on the sheet but skipped this poll because a required cell was empty (D11). */
  midEditCount: number;
}

const DAILY_SHEET = 'daily';

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && 'result' in value && value.result !== undefined) {
    return cellText(value.result as ExcelJS.CellValue);
  }
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text.trim() || null;
  }
  return null;
}

function cellNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'result' in value) {
    const r = (value as { result?: unknown }).result;
    if (typeof r === 'number') return r;
  }
  const t = cellText(value);
  if (t === null) return null;
  const n = Number(t.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD' | ISO | Date → 'YYYY-MM-DD', else null (malformed date = mid-edit). */
function normalizeDayKey(value: ExcelJS.CellValue): string | null {
  const t = cellText(value);
  if (t === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export async function parseDailyRows(data: Uint8Array | ArrayBuffer | Buffer): Promise<DailyParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ExcelJS.Buffer);
  const sheet = wb.worksheets.find((w) => w.name.toLowerCase() === DAILY_SHEET);
  const rows: DailyProductionRow[] = [];
  let midEditCount = 0;
  if (!sheet) return { rows, midEditCount };

  sheet.eachRow((row, rowIndex) => {
    if (rowIndex === 1) return; // header
    const productionDate = normalizeDayKey(row.getCell(1).value);
    const strippedProgram = cellNumber(row.getCell(2).value);
    // A completely blank trailing row is not a record at all — ignore, don't count.
    if (productionDate === null && strippedProgram === null && cellText(row.getCell(4).value) === null) return;
    // Required cells missing ⇒ mid-edit: skip + count, retried next poll (D11).
    if (productionDate === null || strippedProgram === null) {
      midEditCount += 1;
      return;
    }
    rows.push({
      productionDate,
      strippedProgram,
      strippedNonProgram: cellNumber(row.getCell(3).value) ?? 0,
      materialTicketNumber: cellText(row.getCell(4).value),
      employeesCount: cellNumber(row.getCell(5).value),
      processorsCount: cellNumber(row.getCell(6).value),
      savedUnits: cellNumber(row.getCell(7).value),
    });
  });

  return { rows, midEditCount };
}
