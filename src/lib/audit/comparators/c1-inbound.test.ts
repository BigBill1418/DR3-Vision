import { describe, expect, it } from 'vitest';
import { c1Inbound } from './c1-inbound';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow, InboundLegRow, MirrorHaulRow } from '../types';

const config = defaultCheckConfigMap().get('c1_inbound')!;
const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-15' };

function inbound(over: Partial<InboundLegRow> = {}): InboundLegRow {
  return {
    id: 'L1',
    retracId: 'RT-1',
    externalHaulId: 'H-1',
    businessDateISO: '2026-06-05',
    totalUnits: 100,
    programUnits: 80,
    nonProgramUnits: 20,
    slipNumber: 'S-1',
    transportCharged: false,
    source: 'manual',
    sourceSiteName: 'Depot A',
    verifiedAtISO: '2026-06-05T20:00:00Z',
    mymrcSubmittedAtISO: '2026-06-05T21:00:00Z',
    ...over,
  };
}

function haul(over: Partial<MirrorHaulRow> = {}): MirrorHaulRow {
  return {
    externalHaulId: 'H-1',
    retracId: 'RT-1',
    businessDateISO: '2026-06-05',
    units: 100,
    weightLbs: null,
    status: 'received',
    entryDateISO: '2026-06-05',
    firstSeenAtISO: '2026-06-05T22:00:00Z',
    ...over,
  };
}

describe('C1 inbound', () => {
  it('agree → no findings', () => {
    expect(c1Inbound(window, [inbound()], [haul()], config)).toHaveLength(0);
  });

  it('value mismatch on units', () => {
    const f = c1Inbound(window, [inbound({ totalUnits: 105 })], [haul({ units: 100 })], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('value_mismatch');
    expect(f[0]!.expected).toEqual({ units: 105 });
    expect(f[0]!.actual).toEqual({ units: 100 });
  });

  it('null mirror units suppresses the value comparison (detail not fetched)', () => {
    expect(c1Inbound(window, [inbound({ totalUnits: 105 })], [haul({ units: null })], config)).toHaveLength(0);
  });

  it('missing counterpart in MyMRC (leg B) when no haul matches', () => {
    const f = c1Inbound(window, [inbound({ externalHaulId: 'H-9', retracId: 'RT-9' })], [haul()], config);
    // The lone inbound has no mirror, and the lone haul has no inbound → two missing findings.
    expect(f.filter((x) => x.kind === 'missing_counterpart')).toHaveLength(2);
    const inboundMissing = f.find((x) => x.legARef === 'L1');
    expect(inboundMissing?.legBRef).toBeNull();
  });

  it('missing counterpart in logs (leg A) for an orphan haul', () => {
    const f = c1Inbound(window, [], [haul()], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('missing_counterpart');
    expect(f[0]!.legARef).toBeNull();
    expect(f[0]!.legBRef).toBe('H-1');
  });

  it('date mismatch', () => {
    const f = c1Inbound(window, [inbound({ businessDateISO: '2026-06-06' })], [haul({ businessDateISO: '2026-06-05' })], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('date_mismatch');
  });

  it('joins on Re-TRAC id when the external haul id is absent', () => {
    const f = c1Inbound(window, [inbound({ externalHaulId: null })], [haul({ externalHaulId: 'H-DIFFERENT' })], config);
    expect(f).toHaveLength(0);
  });

  it('respects unit tolerance', () => {
    const tol = { ...config, unitTolerance: 5 };
    expect(c1Inbound(window, [inbound({ totalUnits: 104 })], [haul({ units: 100 })], tol)).toHaveLength(0);
    expect(c1Inbound(window, [inbound({ totalUnits: 106 })], [haul({ units: 100 })], tol)).toHaveLength(1);
  });

  it('is a no-op when disabled', () => {
    expect(c1Inbound(window, [inbound({ totalUnits: 999 })], [haul()], { ...config, enabled: false })).toHaveLength(0);
  });
});
