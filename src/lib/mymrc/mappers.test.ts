import { describe, expect, it } from 'vitest';
import {
  __mapperInternals,
  listRecordIds,
  mapHaulRecord,
  mapOutboundRecord,
  mapProcessedRecord,
} from './mappers';
import type { GetItemsReturnValue, SfRecord } from './types';

// Fixtures captured LIVE from the MyMRC portal (DR3 Woodland, 2026-07-03),
// person names redacted. See __fixtures__/README once written.
import haulFixture from './__fixtures__/aura-getrecord-haul.json';
import processedFixture from './__fixtures__/aura-getrecord-processed.json';
import outboundFixture from './__fixtures__/aura-getrecord-outbound.json';
import getItemsProcessed from './__fixtures__/aura-getitems-processed.json';
import getItemsHauls from './__fixtures__/aura-getitems-hauls.json';

const haul = haulFixture as unknown as SfRecord;
const processed = processedFixture as unknown as SfRecord;
const outbound = outboundFixture as unknown as SfRecord;

describe('listRecordIds', () => {
  it('extracts ordered Salesforce record ids from a getItems returnValue', () => {
    const ids = listRecordIds(getItemsProcessed as GetItemsReturnValue);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toBe('a2LUJ000001N4gf2AC');
    expect(ids.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('reads the hauls list (14 rows captured, trimmed to 5 in fixture)', () => {
    const ids = listRecordIds(getItemsHauls as GetItemsReturnValue);
    expect(ids.length).toBe(5);
  });

  it('returns [] for a missing/empty recordIdActionsList', () => {
    expect(listRecordIds({})).toEqual([]);
    expect(listRecordIds({ recordIdActionsList: null })).toEqual([]);
    expect(listRecordIds({ recordIdActionsList: [] })).toEqual([]);
  });

  it('skips null entries and blank ids', () => {
    const rv: GetItemsReturnValue = {
      recordIdActionsList: [null, { recordId: '' }, { recordId: 'a2LX' }, { recordId: null }],
    };
    expect(listRecordIds(rv)).toEqual(['a2LX']);
  });
});

describe('mapHaulRecord', () => {
  const row = mapHaulRecord(haul);

  it('maps Salesforce id → mirror id and Name → external_id + retrac_id (1:1)', () => {
    expect(row.id).toBe('a2KUJ00000G6id32AB');
    expect(row.external_id).toBe('H-133323');
    expect(row.retrac_id).toBe('H-133323');
  });

  it('maps status, rate, and dock door', () => {
    expect(row.status).toBe('Confirmed');
    expect(row.rate_id).toBe('Yolo County Central Landfill - Ron Lawrence & Son - DR3 Woodland');
    expect(row.door).toBe('Dock Door 1');
  });

  it('parses the Pacific docking appointment time to a UTC instant (14:30 PDT → 21:30Z)', () => {
    expect(row.docking_appointment_at?.toISOString()).toBe('2026-07-03T21:30:00.000Z');
  });

  it('retains the full raw record as payload', () => {
    expect((row.payload as SfRecord).apiName).toBe('Haul_Request__c');
  });

  it('leaves absent fields null (no units/weight on the haul record)', () => {
    expect(row.units).toBeNull();
    expect(row.weight_lbs).toBeNull();
  });
});

describe('mapProcessedRecord', () => {
  const row = mapProcessedRecord(processed);

  it('maps materials number, dates (noon UTC), and program units', () => {
    expect(row.id).toBe('a2LUJ000001N4gf2AC');
    expect(row.external_id).toBe('M-000300');
    expect(row.retrac_id).toBe('M-000300');
    expect(row.entry_date?.toISOString()).toBe('2024-03-01T12:00:00.000Z');
    expect(row.processed_date?.toISOString()).toBe('2024-03-01T12:00:00.000Z');
    expect(row.units).toBe(510);
  });

  it('maps a null BOL to null (not the string "null")', () => {
    expect(row.bol_id).toBeNull();
  });
});

describe('mapOutboundRecord', () => {
  const row = mapOutboundRecord(outbound);

  it('maps materials number, BOL, shipment date, and vendor', () => {
    expect(row.id).toBe('a2LUJ000001Mu1N2AS');
    expect(row.external_id).toBe('M-000264');
    expect(row.bol_id).toBe('125829');
    expect(row.shipment_date?.toISOString()).toBe('2024-03-01T12:00:00.000Z');
    expect(row.vendor).toBe('Green Zone');
  });
});

describe('date helpers', () => {
  it('parseIsoDate anchors date-only values at noon UTC and rejects junk', () => {
    expect(__mapperInternals.parseIsoDate('2024-03-01')?.toISOString()).toBe(
      '2024-03-01T12:00:00.000Z',
    );
    expect(__mapperInternals.parseIsoDate(null)).toBeNull();
    expect(__mapperInternals.parseIsoDate('not-a-date')).toBeNull();
  });

  it('parsePacificDateTime is DST-correct (PST winter = UTC-8)', () => {
    // 09:30 PST on Jan 15 → 17:30 UTC.
    expect(__mapperInternals.parsePacificDateTime('2026/01/15 09:30 PT')?.toISOString()).toBe(
      '2026-01-15T17:30:00.000Z',
    );
    // 14:30 PDT on Jul 3 → 21:30 UTC.
    expect(__mapperInternals.parsePacificDateTime('2026/07/03 14:30 PT')?.toISOString()).toBe(
      '2026-07-03T21:30:00.000Z',
    );
  });

  it('parsePacificDateTime returns null on malformed input', () => {
    expect(__mapperInternals.parsePacificDateTime(null)).toBeNull();
    expect(__mapperInternals.parsePacificDateTime('sometime tuesday')).toBeNull();
  });
});
