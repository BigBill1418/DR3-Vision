// ADR-0057 D4 — reconciliation classifier unit tests. Pure function, DB-free.

import { describe, expect, it } from 'vitest';
import {
  detectProcessedRecordChanges,
  extractSourceName,
  type ProcessedMirrorRecord,
  type SourceRow,
  type SourceAliasRow,
} from './reconcile-detect';

const sources: SourceRow[] = [
  { id: 'src-albany', name: 'SVDP Albany' },
  { id: 'src-chico', name: 'Chico Transfer' },
];
const aliases: SourceAliasRow[] = [
  { alias: 'Albany', source_id: 'src-albany' },
  { alias: 'SvdP  Albany', source_id: 'src-albany' }, // spacing/case drift
];

function row(id: string, name: unknown): ProcessedMirrorRecord {
  return { id, payload: { source_name_at_sync: name } };
}

describe('extractSourceName', () => {
  it('reads a flat top-level candidate key', () => {
    expect(extractSourceName({ source_name_at_sync: 'Acme' })).toBe('Acme');
    expect(extractSourceName({ Source_Name__c: 'Beta' })).toBe('Beta');
  });

  it('reads the Salesforce RecordRepresentation { fields: { Key: { value } } } shape', () => {
    expect(extractSourceName({ fields: { Source_Name__c: { value: 'Gamma' } } })).toBe('Gamma');
  });

  it('returns null for missing / empty / non-object payloads', () => {
    expect(extractSourceName(null)).toBeNull();
    expect(extractSourceName('nope')).toBeNull();
    expect(extractSourceName({ source_name_at_sync: '   ' })).toBeNull();
    expect(extractSourceName({ unrelated: 'x' })).toBeNull();
  });
});

describe('detectProcessedRecordChanges', () => {
  it('emits NO candidate when the name matches a source verbatim', () => {
    const out = detectProcessedRecordChanges([row('m1', 'SVDP Albany')], sources, aliases);
    expect(out).toEqual([]);
  });

  it('emits NO candidate when the name resolves via an alias', () => {
    const out = detectProcessedRecordChanges([row('m1', 'Albany')], sources, aliases);
    expect(out).toEqual([]);
  });

  it('emits NO candidate when the name resolves via normalized (case/space) drift', () => {
    // 'svdp albany' normalizes to a canonical-name key; 'ALBANY' to the alias key.
    const out = detectProcessedRecordChanges(
      [row('m1', 'svdp   albany'), row('m2', 'ALBANY')],
      sources,
      aliases,
    );
    expect(out).toEqual([]);
  });

  it('emits a new_record candidate for a name that misses BOTH verbatim and alias', () => {
    const out = detectProcessedRecordChanges([row('m9', 'Roseburg Depot')], sources, aliases);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      change_kind: 'new_record',
      mirror_table: 'mymrc_processed_mirror',
      mirror_record_id: 'm9',
      target_table: 'sources',
      target_record_id: null,
      field_name: 'name',
      mymrc_value: 'Roseburg Depot',
      suggested_alias: 'roseburg depot',
    });
  });

  it('dedupes multiple mirror rows sharing one unknown name to a single candidate (first row wins)', () => {
    const out = detectProcessedRecordChanges(
      [row('m1', 'Roseburg Depot'), row('m2', 'roseburg  depot'), row('m3', 'Roseburg Depot')],
      sources,
      aliases,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.mirror_record_id).toBe('m1');
  });

  it('skips rows with no extractable name', () => {
    const out = detectProcessedRecordChanges(
      [{ id: 'm1', payload: { unrelated: true } }, row('m2', 'Roseburg Depot')],
      sources,
      aliases,
    );
    expect(out.map((c) => c.mirror_record_id)).toEqual(['m2']);
  });

  it('handles empty inputs', () => {
    expect(detectProcessedRecordChanges([], sources, aliases)).toEqual([]);
    expect(detectProcessedRecordChanges([row('m1', 'X')], [], [])).toHaveLength(1);
  });
});
