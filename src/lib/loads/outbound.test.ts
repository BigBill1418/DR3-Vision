// ADR-0037 D4 (Addendum B1) — outbound_materials shape validation. `renovation`
// rows carry whole units + a reconciling pool split; `baled`/`shredded` rows are
// weight-based and must NOT carry unit fields.

import { describe, it, expect } from 'vitest';
import { assertOutboundShape } from './outbound';
import { RecordValidationError } from '@/lib/loads/record-guards';

describe('assertOutboundShape — renovation whole-unit split', () => {
  it('accepts a renovation row whose program + non-program equals whole units', () => {
    expect(assertOutboundShape('renovation', 10, 4, 6)).toEqual({
      wholeUnits: 10,
      programUnits: 4,
      nonProgramUnits: 6,
    });
  });

  it('accepts a one-sided split (the other half defaults to 0 and still reconciles)', () => {
    expect(assertOutboundShape('renovation', 10, 10, undefined)).toEqual({
      wholeUnits: 10,
      programUnits: 10,
      nonProgramUnits: 0,
    });
  });

  it('rejects whole units with no reconciling split (both halves default to 0)', () => {
    expect(() => assertOutboundShape('renovation', 10, undefined, undefined)).toThrow(RecordValidationError);
  });

  it('rejects a renovation split that does not sum to whole units', () => {
    expect(() => assertOutboundShape('renovation', 10, 4, 5)).toThrow(RecordValidationError);
  });

  it('allows a renovation row with all unit fields null (unknown split)', () => {
    expect(assertOutboundShape('renovation', null, null, null)).toEqual({
      wholeUnits: null,
      programUnits: null,
      nonProgramUnits: null,
    });
  });

  it('rejects a renovation split given without whole units', () => {
    expect(() => assertOutboundShape('renovation', null, 4, 6)).toThrow(RecordValidationError);
  });
});

describe('assertOutboundShape — weight-based commodity sales', () => {
  it('accepts a baled row with no unit fields', () => {
    expect(assertOutboundShape('baled', null, null, null)).toEqual({
      wholeUnits: null,
      programUnits: null,
      nonProgramUnits: null,
    });
  });

  it('rejects a baled/shredded row that carries whole units', () => {
    expect(() => assertOutboundShape('baled', 5, null, null)).toThrow(RecordValidationError);
    expect(() => assertOutboundShape('shredded', null, 2, null)).toThrow(RecordValidationError);
  });
});
