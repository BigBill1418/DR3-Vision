// ADR-0057 Phase 1 — classifier against the REAL Phase-0 source-carrying fields:
//   Materials__c.Account__r.Name        (processed)
//   Haul_Request__c.Collection_Site__c / Collection_Source__c (hauls)
// Complements reconcile-detect.test.ts (which locks the flat-key behavior).

import { describe, expect, it } from 'vitest';
import {
  detectHaulRecordChanges,
  detectProcessedRecordChanges,
  extractHaulSourceName,
  extractSourceName,
  type HaulMirrorRecord,
  type ProcessedMirrorRecord,
  type SourceAliasRow,
  type SourceRow,
} from './reconcile-detect';

const sources: SourceRow[] = [
  { id: 'src-albany', name: 'SVDP Albany' },
  { id: 'src-woodland', name: 'DR3 Woodland' },
];
const aliases: SourceAliasRow[] = [{ alias: 'Albany', source_id: 'src-albany' }];

/** A realistic Materials__c RecordRepresentation payload (mirror `payload` shape). */
function processedPayload(accountName: string | null, materialsNumber = 'M-000264'): unknown {
  const fields: Record<string, unknown> = {
    Name: { displayValue: null, value: materialsNumber },
    Type__c: { displayValue: null, value: 'Processing' },
  };
  if (accountName !== null) {
    fields['Account__r'] = {
      displayValue: accountName,
      value: {
        apiName: 'Account',
        id: '0014600000is4tFAAQ',
        fields: { Name: { displayValue: null, value: accountName } },
      },
    };
    fields['Account__c'] = { displayValue: null, value: '0014600000is4tFAAQ' };
  }
  return { apiName: 'Materials__c', id: 'a2LUJ0000000001AAA', fields };
}

function haulPayload(site: string | null, source: string | null): unknown {
  const fields: Record<string, unknown> = { Name: { displayValue: null, value: 'H-133323' } };
  if (site !== null) fields['Collection_Site__c'] = { displayValue: null, value: site };
  if (source !== null) fields['Collection_Source__c'] = { displayValue: null, value: source };
  return { apiName: 'Haul_Request__c', id: 'a2KUJ00000G6id32AB', fields };
}

describe('extractSourceName (real Materials__c payload)', () => {
  it('reads Account__r.Name — the site discriminator — NOT the flat Name (Materials number)', () => {
    expect(extractSourceName(processedPayload('SVDP Roseburg'))).toBe('SVDP Roseburg');
  });

  it('does NOT fall back to the flat Name (M-####) when Account__r is absent', () => {
    // The bare `Name` on Materials__c is the Materials number, never a source —
    // a record with no Account link is unclassifiable, not "source = M-000264".
    expect(extractSourceName(processedPayload(null))).toBeNull();
  });

  it('falls back to the relationship displayValue when the nested Name is blank', () => {
    const payload = {
      apiName: 'Materials__c',
      id: 'a2L1',
      fields: {
        Account__r: {
          displayValue: 'SVDP Eugene',
          value: { apiName: 'Account', id: '001x', fields: { Name: { value: '  ' } } },
        },
      },
    };
    expect(extractSourceName(payload)).toBe('SVDP Eugene');
  });
});

describe('extractHaulSourceName (real Haul_Request__c payload)', () => {
  it('prefers Collection_Site__c', () => {
    expect(extractHaulSourceName(haulPayload('Roseburg Depot', 'Consumer Drop-Off'))).toBe(
      'Roseburg Depot',
    );
  });

  it('falls back to Collection_Source__c when the site is absent', () => {
    expect(extractHaulSourceName(haulPayload(null, 'Consumer Drop-Off'))).toBe('Consumer Drop-Off');
  });

  it('returns null when neither field is present', () => {
    expect(extractHaulSourceName(haulPayload(null, null))).toBeNull();
  });
});

describe('detectProcessedRecordChanges (Account__r.Name)', () => {
  it('emits a candidate for an unknown account name, keyed to the processed mirror', () => {
    const rows: ProcessedMirrorRecord[] = [{ id: 'a2L9', payload: processedPayload('SVDP Roseburg') }];
    const out = detectProcessedRecordChanges(rows, sources, aliases);
    expect(out).toEqual([
      {
        change_kind: 'new_record',
        mirror_table: 'mymrc_processed_mirror',
        mirror_record_id: 'a2L9',
        target_table: 'sources',
        target_record_id: null,
        field_name: 'name',
        mymrc_value: 'SVDP Roseburg',
        suggested_alias: 'svdp roseburg',
      },
    ]);
  });

  it('emits NO candidate for a known account name (verbatim)', () => {
    const rows: ProcessedMirrorRecord[] = [{ id: 'a2L1', payload: processedPayload('DR3 Woodland') }];
    expect(detectProcessedRecordChanges(rows, sources, aliases)).toEqual([]);
  });
});

describe('detectHaulRecordChanges (Collection_Site__c / Collection_Source__c)', () => {
  it('emits a hauls-mirror candidate for an unknown collection site', () => {
    const rows: HaulMirrorRecord[] = [{ id: 'a2K9', payload: haulPayload('Roseburg Depot', null) }];
    const out = detectHaulRecordChanges(rows, sources, aliases);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      mirror_table: 'mymrc_hauls_mirror',
      mirror_record_id: 'a2K9',
      mymrc_value: 'Roseburg Depot',
      suggested_alias: 'roseburg depot',
    });
  });

  it('emits NO candidate when the collection site resolves via an alias', () => {
    const rows: HaulMirrorRecord[] = [{ id: 'a2K1', payload: haulPayload('Albany', null) }];
    expect(detectHaulRecordChanges(rows, sources, aliases)).toEqual([]);
  });

  it('dedupes multiple hauls sharing one unknown site to a single candidate (first wins)', () => {
    const rows: HaulMirrorRecord[] = [
      { id: 'a2K1', payload: haulPayload('Roseburg Depot', null) },
      { id: 'a2K2', payload: haulPayload('roseburg  depot', null) },
    ];
    const out = detectHaulRecordChanges(rows, sources, aliases);
    expect(out).toHaveLength(1);
    expect(out[0]?.mirror_record_id).toBe('a2K1');
  });
});
