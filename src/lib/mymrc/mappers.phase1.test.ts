import { describe, expect, it } from 'vitest';
import {
  __mapperInternals,
  classifyMaterialsType,
  listRecordIds,
  mapDockAvailabilityRecord,
  mapHaulRecord,
  mapOutboundRecord,
  mapProcessedRecord,
} from './mappers';
import type { GetItemsReturnValue, SfRecord } from './types';

// SYNTHETIC fixtures — real Phase-0 Aura structure, fabricated values (DR3
// Testville). See __fixtures__/phase1/README.md. No real PII is committed.
import haulFixture from './__fixtures__/phase1/haul-getrecord.json';
import processedFixture from './__fixtures__/phase1/processed-getrecord.json';
import outboundFixture from './__fixtures__/phase1/outbound-getrecord.json';
import dockFixture from './__fixtures__/phase1/dock-getrecord.json';
import haulItems from './__fixtures__/phase1/haul-getitems.json';
import processedItems from './__fixtures__/phase1/processed-getitems.json';
import outboundItems from './__fixtures__/phase1/outbound-getitems.json';
import dockItems from './__fixtures__/phase1/dock-getitems.json';

const haul = haulFixture as unknown as SfRecord;
const processed = processedFixture as unknown as SfRecord;
const outbound = outboundFixture as unknown as SfRecord;
const dock = dockFixture as unknown as SfRecord;

/** An all-null Salesforce record: mappers must degrade to nulls, never throw. */
function emptyRecord(apiName: string, id: string): SfRecord {
  const nul = { displayValue: null, value: null };
  return {
    apiName,
    id,
    fields: {
      Name: nul,
      Status__c: nul,
      Type__c: nul,
      Recycling_Center_Lookup__r: nul,
      Account__r: nul,
    },
  };
}

describe('mapHaulRecord — real Phase-0 fields', () => {
  const row = mapHaulRecord(haul);

  it('maps identity, external id (→ external_haul_id), and 1:1 retrac id', () => {
    expect(row.id).toBe('a2KUJ00000SYNTH01AB');
    expect(row.external_id).toBe('H-900001');
    expect(row.retrac_id).toBe('H-900001');
  });

  it('maps the picklist + descriptor fields from `value`', () => {
    expect(row.status).toBe('Confirmed');
    expect(row.type).toBe('General');
    expect(row.commodity).toBe('Whole Mattresses and Foundations');
    expect(row.rate_id).toContain('Testville Transfer Station');
    expect(row.collection_site).toBe('Testville Transfer Station');
    expect(row.door).toBe('Dock Door 1');
  });

  it('stores Container_Type__c raw, preserving the typographic apostrophe U+2019', () => {
    expect(row.container_type).toBe('28’ Trailer');
    expect(row.container_type).toContain('’'); // NOT the ASCII apostrophe
    expect(row.container_type).not.toContain("'");
  });

  it('resolves the site discriminator from the __r relationship + the bare __c id', () => {
    expect(row.recycler_name).toBe('DR3 Testville'); // Recycling_Center_Lookup__r.Name
    expect(row.recycler_account_id).toBe('001460000SYNTHTVLAAQ'); // Recycling_Center_Lookup__c
  });

  it('reads the transporter as a denormalized name string (not an FK)', () => {
    expect(row.transporter_name).toBe('Synthetic Hauling Co - DR3 parent account CA');
  });

  it('maps billing-authoritative unit counts (0-safe) and mirrors into legacy units', () => {
    expect(row.program_unit_count).toBe(42); // Recycler_Program_Unit_Count__c
    expect(row.non_program_unit_count).toBe(3);
    expect(row.unpaid_consumer_dropoff_units).toBeNull();
    expect(row.units).toBe(42); // legacy back-compat mirror of program_unit_count
  });

  it('maps Recycler_Weight__c to weight_lbs (not the non-existent Weight__c)', () => {
    expect(row.weight_lbs).toBe(1234.5);
  });

  it('maps the date-only appointment field at noon UTC', () => {
    expect(row.docking_appointment_date?.toISOString()).toBe('2026-07-20T12:00:00.000Z');
  });

  it('parses the free-text Pacific appointment time to a UTC instant (12:00 PDT → 19:00Z)', () => {
    expect(row.docking_appointment_at?.toISOString()).toBe('2026-07-20T19:00:00.000Z');
  });

  it('retains the FULL raw record as payload', () => {
    expect((row.payload as SfRecord).apiName).toBe('Haul_Request__c');
    expect((row.payload as SfRecord).id).toBe('a2KUJ00000SYNTH01AB');
  });
});

describe('mapHaulRecord — consumer drop-off exemplar (Unpaid_Consumer_Drop_Off_Units__c)', () => {
  // Structural exemplar only: the exact Type__c value marking a consumer/illegal
  // drop-off is UNCONFIRMED in Phase-0 (recon §3). The mapper stores raw Type__c
  // and the unpaid-units count without branching, so no billing logic keys on it.
  const dropOff: SfRecord = {
    apiName: 'Haul_Request__c',
    id: 'a2KUJ00000SYNDROP9ZZ',
    fields: {
      Name: { displayValue: null, value: 'H-900099' },
      Type__c: { displayValue: 'Consumer Drop-Off', value: 'Consumer Drop-Off' },
      Recycler_Program_Unit_Count__c: { displayValue: null, value: 0 },
      Unpaid_Consumer_Drop_Off_Units__c: { displayValue: null, value: 7 },
    },
  };

  it('captures the unpaid drop-off units and raw Type__c verbatim', () => {
    const row = mapHaulRecord(dropOff);
    expect(row.unpaid_consumer_dropoff_units).toBe(7);
    expect(row.type).toBe('Consumer Drop-Off');
    expect(row.program_unit_count).toBe(0);
  });
});

describe('mapProcessedRecord — Materials__c (Type__c = Processing)', () => {
  const row = mapProcessedRecord(processed);

  it('maps identity, type, account discriminator, and status', () => {
    expect(row.id).toBe('a2LUJ00000SYNPROC1AC');
    expect(row.external_id).toBe('M-900100');
    expect(row.type).toBe('Processing');
    expect(row.account_name).toBe('DR3 Testville'); // Account__r.Name
    expect(row.account_id).toBe('001460000SYNTHTVLAAQ');
    expect(row.materials_status).toBe('Active');
  });

  it('maps dates at noon UTC and the billable program-unit count', () => {
    expect(row.entry_date?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(row.processed_date?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(row.program_unit_count).toBe(200);
    expect(row.non_program_unit_count).toBe(5);
    expect(row.units).toBe(200);
  });

  it('leaves weight null (Materials__c has no weight field) and a null BOL null', () => {
    expect(row.weight_lbs).toBeNull();
    expect(row.bol_id).toBeNull();
  });
});

describe('mapOutboundRecord — Materials__c (Type__c = Outbound)', () => {
  const row = mapOutboundRecord(outbound);

  it('maps identity, type, BOL, and zero-safe unit counts', () => {
    expect(row.id).toBe('a2LUJ00000SYNOUTB2AG');
    expect(row.external_id).toBe('M-900200');
    expect(row.type).toBe('Outbound');
    expect(row.bol_id).toBe('778899');
    expect(row.program_unit_count).toBe(0);
    expect(row.non_program_unit_count).toBe(0);
  });

  it('yields null vendor from the record detail (Outbound_Vendor_Name__c is list-only)', () => {
    expect(row.vendor).toBeNull();
  });

  it('accepts a list-captured vendor threaded via options', () => {
    const enriched = mapOutboundRecord(outbound, { vendor: 'Synthetic Vendor Co' });
    expect(enriched.vendor).toBe('Synthetic Vendor Co');
  });

  it('leaves weight and shipment_date null (no such fields on Materials__c)', () => {
    expect(row.weight_lbs).toBeNull();
    expect(row.shipment_date).toBeNull();
  });
});

describe('classifyMaterialsType — the Type__c split (one a2L object, two mirrors)', () => {
  it('classifies the two real picklist values', () => {
    expect(classifyMaterialsType(processed)).toBe('Processing');
    expect(classifyMaterialsType(outbound)).toBe('Outbound');
  });

  it('returns null for an unrecognized/absent Type__c (caller handles drift)', () => {
    expect(classifyMaterialsType(emptyRecord('Materials__c', 'a2LX'))).toBeNull();
  });

  it('the same a2L record id can map into BOTH mirror shapes (split is at ingest)', () => {
    // A processing record fed through both mappers keeps its id; the type column
    // records the raw Type__c on each mirror for traceability.
    const asProcessed = mapProcessedRecord(processed);
    const asOutbound = mapOutboundRecord(processed);
    expect(asProcessed.id).toBe(asOutbound.id);
    expect(asProcessed.type).toBe('Processing');
    expect(asOutbound.type).toBe('Processing');
  });
});

describe('mapDockAvailabilityRecord — NEW scheduling object', () => {
  const row = mapDockAvailabilityRecord(dock);

  it('maps identity (→ external_schedule_id) and status', () => {
    expect(row.id).toBe('a1tUJ00000SYNDOCK1AE');
    expect(row.external_id).toBe('DA-SCHED-900050');
    expect(row.status).toBe('Active');
  });

  it('stores Day_of_Week__c RAW numeric codes from `value` (not the weekday displayValue)', () => {
    expect(row.day_of_week).toBe('1;2;3');
  });

  it('stores Container_Type__c raw multipicklist (typographic apostrophe preserved)', () => {
    expect(row.container_type).toBe('20’ Sea Container;28’ Trailer;53’ Trailer');
  });

  it('reads Dock_Door__c `value` (canonical), NOT the "Schedule N" displayValue', () => {
    expect(row.dock_door).toBe('Dock Door 2');
  });

  it('keeps slot times as verbatim Salesforce Time strings (never Date.parse)', () => {
    expect(row.slot_start_time).toBe('07:00:00.000Z');
    expect(row.slot_end_time).toBe('09:30:00.000Z');
    expect(row.slot_start_time).not.toBeInstanceOf(Date);
  });

  it('maps the appointment count and the date-only start at noon UTC', () => {
    expect(row.available_appointments).toBe(3);
    expect(row.availability_start_date?.toISOString()).toBe('2026-04-15T12:00:00.000Z');
  });

  it('retains the full raw payload', () => {
    expect((row.payload as SfRecord).apiName).toBe('Dock_Availability_Schedule__c');
  });
});

describe('listRecordIds — getItems id extraction per object', () => {
  it('extracts ids from each list feed and reports windowing separately', () => {
    expect(listRecordIds(haulItems as GetItemsReturnValue)).toEqual([
      'a2KUJ00000SYNTH01AB',
      'a2KUJ00000SYNTH02CD',
      'a2KUJ00000SYNTH03EF',
    ]);
    expect(listRecordIds(processedItems as GetItemsReturnValue)).toHaveLength(2);
    expect(listRecordIds(outboundItems as GetItemsReturnValue)).toHaveLength(2);
    expect(listRecordIds(dockItems as GetItemsReturnValue)).toHaveLength(2);
  });

  it('surfaces the completeness signal: hauls windowed, dock exact', () => {
    expect((haulItems as GetItemsReturnValue).hasMoreData).toBe(true);
    expect((dockItems as GetItemsReturnValue).hasMoreData).toBe(false);
  });

  it('outbound list carries the vendor column that the record detail lacks', () => {
    const fields = (outboundItems as { fields: string[] }).fields;
    expect(fields).toContain('Outbound_Vendor_Name__c');
    // ...and that same field is absent from the outbound RECORD detail:
    expect(outbound.fields['Outbound_Vendor_Name__c']).toBeUndefined();
  });
});

describe('null-safety — all-null records degrade without throwing', () => {
  it('mapHaulRecord returns nulls (id + payload preserved)', () => {
    const row = mapHaulRecord(emptyRecord('Haul_Request__c', 'a2K0'));
    expect(row.id).toBe('a2K0');
    expect(row.external_id).toBeNull();
    expect(row.status).toBeNull();
    expect(row.recycler_name).toBeNull();
    expect(row.program_unit_count).toBeNull();
    expect(row.weight_lbs).toBeNull();
    expect(row.docking_appointment_at).toBeNull();
    expect((row.payload as SfRecord).id).toBe('a2K0');
  });

  it('mapProcessedRecord / mapOutboundRecord / mapDockAvailabilityRecord return nulls', () => {
    const p = mapProcessedRecord(emptyRecord('Materials__c', 'a2L0'));
    const o = mapOutboundRecord(emptyRecord('Materials__c', 'a2L1'));
    const d = mapDockAvailabilityRecord(emptyRecord('Dock_Availability_Schedule__c', 'a1t0'));
    expect(p.account_name).toBeNull();
    expect(p.program_unit_count).toBeNull();
    expect(o.vendor).toBeNull();
    expect(o.bol_id).toBeNull();
    expect(d.day_of_week).toBeNull();
    expect(d.slot_start_time).toBeNull();
  });
});

describe('relatedName helper (__mapperInternals)', () => {
  it('reads the nested record Name under value.fields.Name.value', () => {
    expect(__mapperInternals.relatedName(haul, 'Recycling_Center_Lookup__r')).toBe('DR3 Testville');
  });

  it('falls back to the relationship field displayValue when no nested record is present', () => {
    const rec: SfRecord = {
      apiName: 'Haul_Request__c',
      id: 'x',
      fields: { Account__r: { displayValue: 'DR3 Fallback', value: null } },
    };
    expect(__mapperInternals.relatedName(rec, 'Account__r')).toBe('DR3 Fallback');
  });

  it('returns null for an absent relationship (never throws)', () => {
    expect(__mapperInternals.relatedName(emptyRecord('Materials__c', 'y'), 'Missing__r')).toBeNull();
  });
});
