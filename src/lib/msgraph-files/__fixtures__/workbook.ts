// ADR-0049 — fixture workbook builder (mock-first discipline).
//
// Produces REAL .xlsx bytes with exceljs so the whole engine — shared parser
// (ADR-0048/0039) + the daily-production adapter — runs end-to-end without the
// tenant. Two concerns live in one file so mock and live consume identical shapes:
//   - `Summary` / `Inbound` / `Outbound` sheets — the Addendum-B shape the SHARED
//     `parseWorkbook` reads into staging (D12).
//   - a `Daily` sheet — the per-day production rows the sync adapter upserts into
//     `processed_units_daily` (the D3 overwrite target). LOUD NOTE: the real
//     daily-log file's day layout is finalized once Kelsey's `.xlsm` lands; this
//     fixture pins the columns the adapter reads so the contract is testable now.
//
// Daily columns: A=production_date B=stripped_program C=stripped_non_program
//                D=material_ticket E=employees F=processors G=saved_units
// Required (mid-edit guard, D11): production_date + stripped_program.

import ExcelJS from 'exceljs';

export interface FixtureDailyRow {
  date: string; // 'YYYY-MM-DD'
  strippedProgram: number | null; // null → mid-edit (skipped + counted)
  strippedNonProgram?: number;
  materialTicket?: string;
  employees?: number;
  processors?: number;
  savedUnits?: number;
}

export interface FixtureWorkbookSpec {
  daily: FixtureDailyRow[];
  /** Summary figures (shared-parser staging) — a small default set when omitted. */
  summary?: { key: string; value: number }[];
  inbound?: { site: string; sourceType: string; units: number }[];
  outbound?: { commodity: string; subCategory?: string; weightLbs: number }[];
}

/** A representative June-Woodland fixture: three clean days + one mid-edit day. */
export const DEFAULT_FIXTURE_SPEC: FixtureWorkbookSpec = {
  daily: [
    { date: '2026-06-01', strippedProgram: 150, strippedNonProgram: 25, materialTicket: 'M-000401', employees: 6, processors: 4 },
    { date: '2026-06-02', strippedProgram: 175, strippedNonProgram: 12, materialTicket: 'M-000402', employees: 6, processors: 4 },
    { date: '2026-06-03', strippedProgram: 160, strippedNonProgram: 0, materialTicket: 'M-000403', employees: 5, processors: 3 },
    // Mid-edit: date present but stripped_program not yet entered — skipped, retried.
    { date: '2026-06-04', strippedProgram: null },
  ],
  summary: [{ key: 'processed_units_total', value: 485 }],
  inbound: [{ site: 'Woodland', sourceType: 'residential', units: 300 }],
  outbound: [{ commodity: 'steel', subCategory: 'innerspring', weightLbs: 12500 }],
};

export async function buildFixtureWorkbookBytes(spec: FixtureWorkbookSpec = DEFAULT_FIXTURE_SPEC): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();

  const daily = wb.addWorksheet('Daily');
  daily.addRow(['production_date', 'stripped_program', 'stripped_non_program', 'material_ticket', 'employees', 'processors', 'saved_units']);
  for (const r of spec.daily) {
    daily.addRow([
      r.date,
      r.strippedProgram,
      r.strippedNonProgram ?? null,
      r.materialTicket ?? null,
      r.employees ?? null,
      r.processors ?? null,
      r.savedUnits ?? null,
    ]);
  }

  const summary = wb.addWorksheet('Summary');
  summary.addRow(['figure_key', 'stored_value', 'detail_sheet', 'detail_column', 'range_first_row', 'range_last_row']);
  for (const s of spec.summary ?? []) summary.addRow([s.key, s.value, null, null, null, null]);

  const inbound = wb.addWorksheet('Inbound');
  inbound.addRow(['site_name', 'source_type', 'units']);
  for (const i of spec.inbound ?? []) inbound.addRow([i.site, i.sourceType, i.units]);

  const outbound = wb.addWorksheet('Outbound');
  outbound.addRow(['commodity', 'sub_category', 'weight_lbs']);
  for (const o of spec.outbound ?? []) outbound.addRow([o.commodity, o.subCategory ?? null, o.weightLbs]);

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
