// C2 — Processed: `processed_units_daily` (program + non-program) vs
// `mymrc_processed_mirror`, joined by production/processed date. Compares total
// processed units and, when both legs carry the split, the program / NP ledgers.

import type {
  AuditWindow,
  CheckConfig,
  Finding,
  MirrorProcessedRow,
  ProcessedLegRow,
} from '../types';
import { bothPresent, exceedsTolerance, makeFinder } from './helpers';

export function c2Processed(
  window: AuditWindow,
  processed: readonly ProcessedLegRow[],
  mirror: readonly MirrorProcessedRow[],
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('c2_processed', window, config);
  const out: Finding[] = [];

  const mirrorByDay = new Map<string, MirrorProcessedRow>();
  for (const m of mirror) mirrorByDay.set(m.processedDateISO, m);
  const matched = new Set<string>();

  for (const row of processed) {
    const m = mirrorByDay.get(row.productionDateISO);
    if (!m) {
      out.push(
        finding({
          kind: 'missing_counterpart',
          keys: [row.productionDateISO],
          legARef: row.id,
          legBRef: null,
          expected: { units: row.unitsProcessed, date: row.productionDateISO },
          actual: null,
          detail: { leg: 'mymrc', note: 'processed day has no MyMRC processed counterpart' },
        }),
      );
      continue;
    }
    matched.add(m.processedDateISO);

    if (bothPresent(row.unitsProcessed, m.units) && exceedsTolerance(row.unitsProcessed, m.units, config.unitTolerance)) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [row.productionDateISO, 'units'],
          legARef: row.id,
          legBRef: m.externalMaterialsId,
          expected: { units: row.unitsProcessed },
          actual: { units: m.units },
          detail: { field: 'units_processed', tolerance: config.unitTolerance },
        }),
      );
    }

    if (
      bothPresent(row.programUnitsProcessed, m.programUnits) &&
      exceedsTolerance(row.programUnitsProcessed, m.programUnits, config.unitTolerance)
    ) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [row.productionDateISO, 'program'],
          legARef: row.id,
          legBRef: m.externalMaterialsId,
          expected: { programUnits: row.programUnitsProcessed },
          actual: { programUnits: m.programUnits },
          detail: { field: 'program_units', tolerance: config.unitTolerance },
        }),
      );
    }

    if (
      bothPresent(row.nonProgramUnitsProcessed, m.nonProgramUnits) &&
      exceedsTolerance(row.nonProgramUnitsProcessed, m.nonProgramUnits, config.unitTolerance)
    ) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [row.productionDateISO, 'nonprogram'],
          legARef: row.id,
          legBRef: m.externalMaterialsId,
          expected: { nonProgramUnits: row.nonProgramUnitsProcessed },
          actual: { nonProgramUnits: m.nonProgramUnits },
          detail: { field: 'non_program_units', tolerance: config.unitTolerance },
        }),
      );
    }
  }

  for (const m of mirror) {
    if (matched.has(m.processedDateISO)) continue;
    out.push(
      finding({
        kind: 'missing_counterpart',
        keys: [m.processedDateISO],
        legARef: null,
        legBRef: m.externalMaterialsId,
        expected: null,
        actual: { units: m.units, date: m.processedDateISO },
        detail: { leg: 'logs', note: 'MyMRC processed row has no Vision processed-day counterpart' },
      }),
    );
  }

  return out;
}
