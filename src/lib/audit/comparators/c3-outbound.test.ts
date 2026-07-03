import { describe, expect, it } from 'vitest';
import { c3Outbound, type C3LegA } from './c3-outbound';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow, LandfilledLegRow, MirrorOutboundRow, OutboundLegRow } from '../types';

const config = defaultCheckConfigMap().get('c3_outbound')!; // weightTol 50, grace 1
const baseWindow: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-30' };

function outbound(over: Partial<OutboundLegRow> = {}): OutboundLegRow {
  return {
    id: 'O1',
    shipDateISO: '2026-06-05',
    commodity: 'foam',
    subCategory: 'baled',
    weightLbs: 1000,
    wholeUnits: null,
    baleCount: 4,
    ticketNumber: 'M-000123',
    retracId: 'RT-O1',
    buyer: 'Acme',
    source: 'manual',
    eodClosedAtISO: '2026-06-05T23:59:00Z',
    mymrcSubmittedAtISO: '2026-06-06T02:00:00Z',
    ...over,
  };
}

function mirror(over: Partial<MirrorOutboundRow> = {}): MirrorOutboundRow {
  return {
    externalMaterialsId: 'MO-1',
    shipDateISO: '2026-06-05',
    entryDateISO: '2026-06-05',
    weightLbs: 1000,
    units: null,
    ticketNumber: 'M-000123',
    materialType: 'foam',
    vendor: 'Acme',
    ...over,
  };
}

const noLandfill: C3LegA = { outbound: [], landfilled: [] };

describe('C3 outbound', () => {
  it('agree → no findings', () => {
    expect(c3Outbound(baseWindow, { ...noLandfill, outbound: [outbound()] }, [mirror()], config)).toHaveLength(0);
  });

  it('weight within tolerance is not a finding; beyond tolerance is', () => {
    const within = c3Outbound(baseWindow, { ...noLandfill, outbound: [outbound({ weightLbs: 1040 })] }, [mirror({ weightLbs: 1000 })], config);
    expect(within).toHaveLength(0);
    const beyond = c3Outbound(baseWindow, { ...noLandfill, outbound: [outbound({ weightLbs: 1060 })] }, [mirror({ weightLbs: 1000 })], config);
    expect(beyond).toHaveLength(1);
    expect(beyond[0]!.kind).toBe('value_mismatch');
  });

  it('date mismatch', () => {
    const f = c3Outbound(baseWindow, { ...noLandfill, outbound: [outbound({ shipDateISO: '2026-06-06' })] }, [mirror({ shipDateISO: '2026-06-05' })], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('date_mismatch');
  });

  it('EOD+1 grace: a missing MyMRC counterpart is suppressed within grace, fires after', () => {
    const row = outbound({ ticketNumber: 'M-999' }); // ship 2026-06-05, grace 1 → deadline 2026-06-08 (Mon)
    // asOf on the deadline day → still tolerated.
    const within = c3Outbound({ ...baseWindow, asOfISO: '2026-06-08' }, { ...noLandfill, outbound: [row] }, [], config);
    expect(within).toHaveLength(0);
    // asOf past the deadline → fires.
    const after = c3Outbound({ ...baseWindow, asOfISO: '2026-06-09' }, { ...noLandfill, outbound: [row] }, [], config);
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe('missing_counterpart');
  });

  it('historical run (no asOf) applies no grace — missing fires immediately', () => {
    const f = c3Outbound(baseWindow, { ...noLandfill, outbound: [outbound({ ticketNumber: 'M-777' })] }, [], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('missing_counterpart');
  });

  it('orphan mirror row → missing in logs', () => {
    const f = c3Outbound(baseWindow, noLandfill, [mirror()], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.legARef).toBeNull();
    expect(f[0]!.legBRef).toBe('MO-1');
  });

  it('landfilled units join by slip # and flag when missing past grace', () => {
    const lf: LandfilledLegRow = {
      id: 'LF1',
      disposalDateISO: '2026-06-05',
      units: 12,
      slipNumber: 'M-000123',
      reason: 'bed_bug',
      source: 'manual',
    };
    // matched by slip == mirror.ticketNumber → no finding
    expect(c3Outbound(baseWindow, { outbound: [], landfilled: [lf] }, [mirror()], config)).toHaveLength(0);
    // no mirror + historical → missing
    const f = c3Outbound(baseWindow, { outbound: [], landfilled: [lf] }, [], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({ note: expect.stringContaining('landfilled') });
  });
});
