import { describe, expect, it } from 'vitest';
import { c2Processed } from './c2-processed';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow, MirrorProcessedRow, ProcessedLegRow } from '../types';

const config = defaultCheckConfigMap().get('c2_processed')!;
const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-15' };

function processed(over: Partial<ProcessedLegRow> = {}): ProcessedLegRow {
  return {
    id: 'P1',
    productionDateISO: '2026-06-05',
    unitsProcessed: 150,
    programUnitsProcessed: 120,
    nonProgramUnitsProcessed: 30,
    source: 'manual',
    closedAtISO: '2026-06-05T23:00:00Z',
    mymrcSubmittedAtISO: '2026-06-06T15:00:00Z',
    ...over,
  };
}

function mirror(over: Partial<MirrorProcessedRow> = {}): MirrorProcessedRow {
  return {
    externalMaterialsId: 'MP-1',
    processedDateISO: '2026-06-05',
    units: 150,
    programUnits: 120,
    nonProgramUnits: 30,
    entryDateISO: '2026-06-06',
    ...over,
  };
}

describe('C2 processed', () => {
  it('agree → no findings', () => {
    expect(c2Processed(window, [processed()], [mirror()], config)).toHaveLength(0);
  });

  it('total units mismatch', () => {
    const f = c2Processed(window, [processed({ unitsProcessed: 155 })], [mirror({ units: 150 })], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('value_mismatch');
  });

  it('program split mismatch is its own finding', () => {
    const f = c2Processed(window, [processed({ programUnitsProcessed: 125 })], [mirror({ programUnits: 120 })], config);
    expect(f.map((x) => x.detail)).toContainEqual(expect.objectContaining({ field: 'program_units' }));
  });

  it('missing in MyMRC', () => {
    const f = c2Processed(window, [processed({ productionDateISO: '2026-06-07' })], [mirror()], config);
    expect(f.filter((x) => x.kind === 'missing_counterpart')).toHaveLength(2);
  });

  it('missing in logs for orphan mirror', () => {
    const f = c2Processed(window, [], [mirror()], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.legARef).toBeNull();
  });
});
