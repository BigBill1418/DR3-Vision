// C4 — Billing basis: program-units-processed in the window (leg A) vs billed
// program units (leg B: P2 invoices; historical workbook Summary stands in until
// P2 ships). The billing basis is PROCESSED program units, not inbound
// (mission §3). The caller sets the window (e.g. CA mid-month 1st–15th, Rick Q2).

import type { AuditWindow, BillingLegRow, CheckConfig, Finding, ProcessedLegRow } from '../types';
import { makeFinder } from './helpers';

/** Sum program units processed across the window (falls back to total if the split is absent). */
export function sumProgramUnitsProcessed(rows: readonly ProcessedLegRow[]): number {
  let sum = 0;
  for (const r of rows) {
    sum += r.programUnitsProcessed ?? r.unitsProcessed;
  }
  return sum;
}

export function c4BillingBasis(
  window: AuditWindow,
  processed: readonly ProcessedLegRow[],
  billing: BillingLegRow | null,
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('c4_billing_basis', window, config);
  const processedProgram = sumProgramUnitsProcessed(processed);

  if (!billing) {
    return [
      finding({
        kind: 'missing_counterpart',
        keys: [window.startISO, window.endISO],
        legARef: null,
        legBRef: null,
        expected: { programUnits: processedProgram },
        actual: null,
        detail: { leg: 'billing', note: 'no billing leg (invoice/workbook summary) for window' },
      }),
    ];
  }

  if (Math.abs(processedProgram - billing.programUnitsBilled) > config.unitTolerance) {
    return [
      finding({
        kind: 'value_mismatch',
        keys: [window.startISO, window.endISO],
        legARef: null,
        legBRef: billing.ref,
        expected: { programUnits: processedProgram },
        actual: { programUnits: billing.programUnitsBilled, source: billing.source },
        detail: { field: 'program_units_billed', tolerance: config.unitTolerance },
      }),
    ];
  }

  return [];
}
