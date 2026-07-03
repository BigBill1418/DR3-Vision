// Synthetic workbook fixtures for the ADR-0039 parser + summary-recompute tests.
// Built with exceljs so the suite never needs the real (unavailable) daily-log
// file. Exercises all three template generations AND the §4.1 sum-range-drift
// exhibit (fuel rows 71–130 clipped while detail extends to 140).

import ExcelJS from 'exceljs';
import type { TemplateGeneration } from '../parser';

function setRow(ws: ExcelJS.Worksheet, rowIndex: number, values: (string | number | null)[]): void {
  const row = ws.getRow(rowIndex);
  values.forEach((v, i) => {
    if (v !== null) row.getCell(i + 1).value = v;
  });
  row.commit();
}

const SUMMARY_HEADER = [
  'figure_key',
  'stored_value',
  'detail_sheet',
  'detail_column',
  'range_first_row',
  'range_last_row',
];

/**
 * The sum-range-drift exhibit. The "Fuel" Summary figure sums FuelDetail!B71:B130
 * (60 rows × $10 = $600 stored), but the detail block actually runs 71→140 —
 * rows 131–140 (another $100) were silently clipped. The recompute must catch it.
 */
export async function buildDriftWorkbook(): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();

  const summary = wb.addWorksheet('Summary');
  setRow(summary, 1, SUMMARY_HEADER);
  setRow(summary, 2, ['Fuel', 600, 'FuelDetail', 'B', 71, 130]);
  // A balanced control figure (no drift) to prove the check is specific.
  setRow(summary, 3, ['Transport', 300, 'TransportDetail', 'B', 5, 7]);

  const fuel = wb.addWorksheet('FuelDetail');
  setRow(fuel, 1, ['label', 'amount']);
  for (let r = 71; r <= 140; r++) setRow(fuel, r, [`fuel-${r}`, 10]);

  const transport = wb.addWorksheet('TransportDetail');
  setRow(transport, 1, ['label', 'amount']);
  for (let r = 5; r <= 7; r++) setRow(transport, r, [`haul-${r}`, 100]);

  const inbound = wb.addWorksheet('Inbound');
  setRow(inbound, 1, ['site_name', 'source_type', 'units']);
  setRow(inbound, 2, ['Depot Alpha', 'standard_haul', 40]);
  setRow(inbound, 3, ['VAcaville', 'standard_haul', 25]); // drift spelling → resolvable via alias
  setRow(inbound, 4, ['All about Buidling', 'unpaid_consumer_dropoff', 5]); // unresolvable

  return wb.xlsx.writeBuffer();
}

/** A workbook for a given template generation (no drift). */
export async function buildGenerationWorkbook(generation: TemplateGeneration): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('Summary');
  setRow(summary, 1, SUMMARY_HEADER);

  if (generation === 'no_calc') {
    // Stored constants only — no detail sheet / range (calculations absent).
    setRow(summary, 2, ['Fuel', 600, null, null, null, null]);
    setRow(summary, 3, ['Transport', 300, null, null, null, null]);
  } else {
    // calc + eod_carryover: figures reference detail ranges (balanced).
    setRow(summary, 2, ['Fuel', 600, 'FuelDetail', 'B', 2, 61]);
    const fuel = wb.addWorksheet('FuelDetail');
    setRow(fuel, 1, ['label', 'amount']);
    for (let r = 2; r <= 61; r++) setRow(fuel, r, [`fuel-${r}`, 10]);
  }

  const inbound = wb.addWorksheet('Inbound');
  setRow(inbound, 1, ['site_name', 'source_type', 'units']);
  setRow(inbound, 2, ['Depot Alpha', 'standard_haul', 40]);

  const outbound = wb.addWorksheet('Outbound');
  setRow(outbound, 1, ['commodity', 'sub_category', 'weight_lbs']);
  setRow(outbound, 2, ['foam', 'baled', 1200]);
  setRow(outbound, 3, ['toppers', 'renovation', 800]);

  if (generation === 'eod_carryover') {
    const inv = wb.addWorksheet('Inventory');
    setRow(inv, 1, ['date', 'start', 'inbound', 'stripped', 'sold', 'landfilled', 'end']);
    setRow(inv, 2, ['2026-06-05', 100, 50, 20, 5, 5, 120]);
  }

  return wb.xlsx.writeBuffer();
}
