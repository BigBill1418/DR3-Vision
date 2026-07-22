// ADR-0057 Phase 0 — redaction hardening. The FIRST live discovery run left 143
// unredacted person names in the fixtures: audit/lookup fields (CreatedBy,
// LastModifiedBy, *_By__c, Employee_*) carry the person in `displayValue`, which
// the original redactor (nested-person + PII-segment only) never touched. These
// tests lock the FLAT person-name-field scrub while proving business fields
// (site/vendor/transporter names, counts, dates, ids) and structure survive.

import { describe, expect, it } from 'vitest';
import { redactRecord } from './discovery';
import type { SfRecord } from './types';

const REDACTED = '[redacted]';

// A synthetic Haul_Request__c-like record carrying every FLAT person-name field
// shape the live run leaked, alongside the business fields that MUST survive.
function leakyHaul(): SfRecord {
  return {
    apiName: 'Haul_Request__c',
    id: 'a2KUJ00000G6id32AB',
    fields: {
      // Business fields — RETAINED (reconciliation + mapper regression depend on them).
      Name: { displayValue: null, value: 'H-133323' },
      Collection_Site__c: { displayValue: null, value: 'SVDP Roseburg' },
      Collection_Source__c: { displayValue: null, value: 'Consumer Drop-Off' },
      Rate_ID__c: { displayValue: null, value: 'Yolo Central - Ron Lawrence & Son - DR3 Woodland' },
      Recycler_Program_Unit_Count__c: { displayValue: '42', value: 42 },
      Docking_Appointment_Date__c: { displayValue: '7/3/2026', value: '2026-07-03' },
      // Person-name fields — MUST be scrubbed (the 143-name leak class).
      Cancelled_By__c: { displayValue: 'John Canceller', value: '005UJ0000011jXaYAI' },
      Approved_By__c: { displayValue: 'Pat Approver', value: 'Pat Approver' },
      Received_By: { displayValue: null, value: 'Dana Receiver' },
      Employee_Name__c: { displayValue: null, value: 'Bob Employee' },
      Employee_Signature__c: { displayValue: 'Bob Employee', value: 'signed-blob' },
      CreatedById: { displayValue: 'Sam Admin', value: '005UJ0000011kYbZAJ' },
      LastModifiedById: { displayValue: 'Jane Operator', value: '005UJ0000011jixYAA' },
      OwnerId: { displayValue: 'Casey Owner', value: '005UJ0000011zzzAAA' },
    },
  };
}

describe('redactRecord — flat person-name fields', () => {
  const out = redactRecord(leakyHaul());
  const f = (k: string) => out.fields[k];

  it('scrubs the *_By__c custom fields (displayValue name), keeping opaque ids', () => {
    expect(f('Cancelled_By__c')?.displayValue).toBe(REDACTED);
    expect(f('Cancelled_By__c')?.value).toBe('005UJ0000011jXaYAI'); // 18-char SF id kept
    expect(f('Approved_By__c')?.displayValue).toBe(REDACTED);
    expect(f('Approved_By__c')?.value).toBe(REDACTED); // value was a bare name
    expect(f('Received_By')?.value).toBe(REDACTED);
  });

  it('scrubs Employee_* fields (name in value or displayValue)', () => {
    expect(f('Employee_Name__c')?.value).toBe(REDACTED);
    expect(f('Employee_Signature__c')?.displayValue).toBe(REDACTED);
    expect(f('Employee_Signature__c')?.value).toBe(REDACTED);
  });

  it('scrubs the …ById standard lookups (displayValue name), keeping the id value', () => {
    expect(f('CreatedById')?.displayValue).toBe(REDACTED);
    expect(f('CreatedById')?.value).toBe('005UJ0000011kYbZAJ');
    expect(f('LastModifiedById')?.displayValue).toBe(REDACTED);
    expect(f('OwnerId')?.displayValue).toBe(REDACTED);
    expect(f('OwnerId')?.value).toBe('005UJ0000011zzzAAA');
  });

  it('RETAINS business fields — site/source/rate names, counts, dates, object id', () => {
    expect(f('Name')?.value).toBe('H-133323');
    expect(f('Collection_Site__c')?.value).toBe('SVDP Roseburg');
    expect(f('Collection_Source__c')?.value).toBe('Consumer Drop-Off');
    expect(f('Rate_ID__c')?.value).toBe('Yolo Central - Ron Lawrence & Son - DR3 Woodland');
    expect(f('Recycler_Program_Unit_Count__c')?.value).toBe(42);
    expect(f('Recycler_Program_Unit_Count__c')?.displayValue).toBe('42');
    expect(f('Docking_Appointment_Date__c')?.value).toBe('2026-07-03');
  });

  it('preserves record structure — same keys, same field count, input not mutated', () => {
    const input = leakyHaul();
    const before = JSON.stringify(input);
    const red = redactRecord(input);
    expect(Object.keys(red.fields).sort()).toEqual(Object.keys(input.fields).sort());
    expect(red.apiName).toBe('Haul_Request__c');
    expect(red.id).toBe('a2KUJ00000G6id32AB');
    expect(JSON.stringify(input)).toBe(before); // pure — no in-place mutation
  });

  it('leaves no committed person name anywhere in the redacted JSON', () => {
    const json = JSON.stringify(redactRecord(leakyHaul()));
    for (const name of [
      'John Canceller',
      'Pat Approver',
      'Dana Receiver',
      'Bob Employee',
      'Sam Admin',
      'Jane Operator',
      'Casey Owner',
    ]) {
      expect(json).not.toContain(name);
    }
  });
});
