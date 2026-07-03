import { describe, expect, it } from 'vitest';
import { c5Conservation } from './c5-conservation';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow, ConservationRow } from '../types';

const config = defaultCheckConfigMap().get('c5_conservation')!;
const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-02' };

// Rick Q11 worked example: a 200-unit floor = 150 program + 50 non-program.
function floor(over: Partial<ConservationRow> = {}): ConservationRow {
  return {
    dateISO: '2026-06-01',
    inboundProgram: 150,
    priorProcessedProgram: 0,
    programRenovationOutflow: 0,
    programProcessed: 0,
    inboundNonProgram: 50,
    priorProcessedNonProgram: 0,
    nonProgramRenovationOutflow: 0,
    nonProgramProcessed: 0,
    ...over,
  };
}

describe('C5 conservation (Rick Q11 worked example)', () => {
  it('processing 150P + 25NP is LEGAL → no findings', () => {
    const rows = [floor({ programProcessed: 150, nonProgramProcessed: 25 })];
    expect(c5Conservation(window, rows, config)).toHaveLength(0);
  });

  it('processing 151P is ILLEGAL → one program conservation finding', () => {
    const rows = [floor({ programProcessed: 151 })];
    const f = c5Conservation(window, rows, config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('value_mismatch');
    expect(f[0]!.expected).toEqual({ maxProcessable: 150 });
    expect(f[0]!.actual).toEqual({ programProcessed: 151 });
  });

  it('over-processing non-program is its own separate finding', () => {
    const rows = [floor({ nonProgramProcessed: 51 })];
    const f = c5Conservation(window, rows, config);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({ invariant: 'non_program_processed <= non_program_available' });
  });

  it('renovation outflow reduces the program pool', () => {
    // 150 inbound − 0 prior − 30 renovation = 120 available; processing 121 fails.
    const rows = [floor({ programRenovationOutflow: 30, programProcessed: 121 })];
    const f = c5Conservation(window, rows, config);
    expect(f).toHaveLength(1);
    expect(f[0]!.expected).toEqual({ maxProcessable: 120 });
  });

  it('prior processed reduces the available pool', () => {
    const rows = [floor({ priorProcessedProgram: 100, programProcessed: 51 })];
    expect(c5Conservation(window, rows, config)).toHaveLength(1);
    const legal = [floor({ priorProcessedProgram: 100, programProcessed: 50 })];
    expect(c5Conservation(window, legal, config)).toHaveLength(0);
  });
});
