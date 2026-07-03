// C5 — Program / non-program conservation (internal invariant).
//
// Processed program units must not exceed the program units AVAILABLE:
//   availableProgram = inboundProgram − priorProcessedProgram − programRenovationOutflow
// The non-program ledger is conserved SEPARATELY (Woodland co-processing).
//
// Rick Q11's worked example (the acceptance case): a 200-unit floor of 150
// program + 50 non-program. Processing 150P + 25NP is LEGAL (150 ≤ 150, 25 ≤ 50);
// processing 151P is ILLEGAL (151 > 150) and must produce a finding. Renovation
// is an outbound sub-category (Addendum B §B1) whose program share reduces the
// program pool.

import type { AuditWindow, CheckConfig, ConservationRow, Finding } from '../types';
import { makeFinder } from './helpers';

function availableProgram(r: ConservationRow): number {
  return r.inboundProgram - r.priorProcessedProgram - r.programRenovationOutflow;
}

function availableNonProgram(r: ConservationRow): number {
  return r.inboundNonProgram - r.priorProcessedNonProgram - r.nonProgramRenovationOutflow;
}

export function c5Conservation(
  window: AuditWindow,
  rows: readonly ConservationRow[],
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('c5_conservation', window, config);
  const out: Finding[] = [];

  for (const r of rows) {
    const availP = availableProgram(r);
    if (r.programProcessed - availP > config.unitTolerance) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [r.dateISO, 'program'],
          legARef: r.dateISO,
          legBRef: null,
          expected: { maxProcessable: availP },
          actual: { programProcessed: r.programProcessed },
          detail: {
            invariant: 'program_processed <= program_available',
            inboundProgram: r.inboundProgram,
            priorProcessedProgram: r.priorProcessedProgram,
            programRenovationOutflow: r.programRenovationOutflow,
          },
        }),
      );
    }

    const availNP = availableNonProgram(r);
    if (r.nonProgramProcessed - availNP > config.unitTolerance) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [r.dateISO, 'nonprogram'],
          legARef: r.dateISO,
          legBRef: null,
          expected: { maxProcessable: availNP },
          actual: { nonProgramProcessed: r.nonProgramProcessed },
          detail: {
            invariant: 'non_program_processed <= non_program_available',
            inboundNonProgram: r.inboundNonProgram,
            priorProcessedNonProgram: r.priorProcessedNonProgram,
            nonProgramRenovationOutflow: r.nonProgramRenovationOutflow,
          },
        }),
      );
    }
  }

  return out;
}
