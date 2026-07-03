import { describe, expect, it } from 'vitest';
import { c7Deadline, type C7Input } from './c7-deadline';
import { businessDayAddISO } from './helpers';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow, InboundLegRow, OutboundLegRow, ProcessedLegRow } from '../types';

const config = defaultCheckConfigMap().get('c7_deadline')!; // inbound 3, processed 1, outbound 3
const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-30' };

const START = '2026-06-05'; // Friday
const empty: C7Input = { inbound: [], processed: [], outbound: [] };

function inbound(submittedAtISO: string | null): InboundLegRow {
  return {
    id: 'L1',
    retracId: null,
    externalHaulId: null,
    businessDateISO: START,
    totalUnits: 10,
    programUnits: null,
    nonProgramUnits: null,
    slipNumber: null,
    transportCharged: false,
    source: 'manual',
    sourceSiteName: null,
    verifiedAtISO: null,
    mymrcSubmittedAtISO: submittedAtISO,
  };
}

describe('C7 deadline', () => {
  it('inbound submitted on the deadline day → on time (no finding)', () => {
    const deadline = businessDayAddISO(START, 3, []);
    const f = c7Deadline(window, { ...empty, inbound: [inbound(`${deadline}T18:00:00Z`)] }, config);
    expect(f).toHaveLength(0);
  });

  it('inbound submitted after the deadline day → late (date_mismatch)', () => {
    const late = businessDayAddISO(START, 4, []); // strictly after the 3-day deadline
    const f = c7Deadline(window, { ...empty, inbound: [inbound(`${late}T18:00:00Z`)] }, config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('date_mismatch');
    expect(f[0]!.detail).toMatchObject({ clock: 'inbound' });
  });

  it('unsubmitted + asOf past the deadline → overdue', () => {
    const past = businessDayAddISO(START, 5, []);
    const f = c7Deadline({ ...window, asOfISO: past }, { ...empty, inbound: [inbound(null)] }, config);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({ overdue: true });
  });

  it('unsubmitted + asOf before the deadline → not yet late (no finding)', () => {
    const f = c7Deadline({ ...window, asOfISO: START }, { ...empty, inbound: [inbound(null)] }, config);
    expect(f).toHaveLength(0);
  });

  it('historical run (no asOf) treats an unsubmitted record as overdue', () => {
    const f = c7Deadline(window, { ...empty, inbound: [inbound(null)] }, config);
    expect(f).toHaveLength(1);
  });

  it('processed clock is 1 business day', () => {
    const processed: ProcessedLegRow = {
      id: 'P1',
      productionDateISO: START,
      unitsProcessed: 100,
      programUnitsProcessed: null,
      nonProgramUnitsProcessed: null,
      source: 'manual',
      closedAtISO: null,
      mymrcSubmittedAtISO: `${businessDayAddISO(START, 2, [])}T12:00:00Z`, // 2 > 1 → late
    };
    const f = c7Deadline(window, { ...empty, processed: [processed] }, config);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({ clock: 'processed', businessDays: 1 });
  });

  it('outbound clock starts at EOD close, not ship date', () => {
    // EOD close is the following Monday; a submission 3 business days after ship
    // would be late measured from ship but on-time measured from EOD.
    const eodDayISO = '2026-06-08'; // Monday
    const onTimeFromEod = businessDayAddISO(eodDayISO, 3, []);
    const outbound: OutboundLegRow = {
      id: 'O1',
      shipDateISO: START,
      commodity: 'foam',
      subCategory: 'baled',
      weightLbs: 1000,
      wholeUnits: null,
      baleCount: 4,
      ticketNumber: 'M-1',
      retracId: null,
      buyer: null,
      source: 'manual',
      eodClosedAtISO: `${eodDayISO}T23:59:00Z`,
      mymrcSubmittedAtISO: `${onTimeFromEod}T12:00:00Z`,
    };
    expect(c7Deadline(window, { ...empty, outbound: [outbound] }, config)).toHaveLength(0);
  });
});
