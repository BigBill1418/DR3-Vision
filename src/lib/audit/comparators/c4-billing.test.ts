import { describe, expect, it } from 'vitest';
import { c4BillingBasis } from './c4-billing';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow, BillingLegRow, ProcessedLegRow } from '../types';

const config = defaultCheckConfigMap().get('c4_billing_basis')!;
const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-16' };

function processed(program: number | null, total = program ?? 0): ProcessedLegRow {
  return {
    id: `P-${program}-${total}`,
    productionDateISO: '2026-06-05',
    unitsProcessed: total,
    programUnitsProcessed: program,
    nonProgramUnitsProcessed: null,
    source: 'manual',
    closedAtISO: null,
    mymrcSubmittedAtISO: null,
  };
}

const billing = (units: number): BillingLegRow => ({
  windowStartISO: window.startISO,
  windowEndISO: window.endISO,
  programUnitsBilled: units,
  ref: 'WB-Summary-June',
  source: 'workbook_summary',
});

describe('C4 billing basis', () => {
  it('agree → no findings', () => {
    expect(c4BillingBasis(window, [processed(100), processed(50)], billing(150), config)).toHaveLength(0);
  });

  it('mismatch between processed program units and billed', () => {
    const f = c4BillingBasis(window, [processed(100)], billing(90), config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('value_mismatch');
    expect(f[0]!.expected).toEqual({ programUnits: 100 });
  });

  it('missing billing leg', () => {
    const f = c4BillingBasis(window, [processed(100)], null, config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('missing_counterpart');
  });

  it('falls back to total when the program split is null', () => {
    expect(c4BillingBasis(window, [processed(null, 100)], billing(100), config)).toHaveLength(0);
  });
});
