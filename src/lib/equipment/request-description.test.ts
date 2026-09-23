// ADR-0135 E — the structured approver request: the one-unit rule, the
// required-unit rule, and the text shape the decide route carries.

import { describe, expect, it } from 'vitest';
import {
  REQUEST_PROBLEM_MESSAGE,
  checkEquipmentRequest,
  composeEquipmentRequest,
  formatEquipmentRequestDescription,
  parseEquipmentRequestDescription,
} from './request-description';

const trailer = (unitNumber: string) => ({ assetType: 'trailer', unitNumber });

describe('checkEquipmentRequest — ONE unit per request', () => {
  it.each([
    '53489, 5340, 35',
    '5327 5340',
    'trailer 5327',
    '5327 and 5340',
    '5327/5340',
    '5327&5340',
  ])('refuses %j', (unit) => {
    expect(checkEquipmentRequest(trailer(unit))).toBe('unit_invalid');
  });

  it.each(['#19', '# 19', '32-48', 'EQ24', '5327', '  5327  '])('accepts %j', (unit) => {
    expect(checkEquipmentRequest(trailer(unit))).toBeNull();
  });

  it('refuses a unit with no digits (not a unit number)', () => {
    expect(checkEquipmentRequest(trailer('blue'))).toBe('unit_invalid');
  });

  it('refuses an over-long unit', () => {
    expect(checkEquipmentRequest(trailer('1'.repeat(41)))).toBe('unit_invalid');
  });
});

describe('checkEquipmentRequest — type and required fields', () => {
  it('requires a known type', () => {
    expect(checkEquipmentRequest({ assetType: '', unitNumber: '5327' })).toBe('type');
    expect(checkEquipmentRequest({ assetType: 'spaceship', unitNumber: '5327' })).toBe('type');
  });

  it.each(['trailer', 'semi_truck', 'box_truck', 'van', 'pickup', 'forklift'])(
    'requires a unit number for %s',
    (assetType) => {
      expect(checkEquipmentRequest({ assetType, unitNumber: '', notes: 'the blue one' })).toBe(
        'unit_required',
      );
    },
  );

  it('a baler without a unit number needs notes (or a make)', () => {
    expect(checkEquipmentRequest({ assetType: 'baler', unitNumber: '' })).toBe('notes_required');
    expect(checkEquipmentRequest({ assetType: 'baler', unitNumber: '', notes: '   ' })).toBe(
      'notes_required',
    );
    expect(
      checkEquipmentRequest({ assetType: 'baler', unitNumber: '', notes: 'the vertical baler' }),
    ).toBeNull();
    expect(
      checkEquipmentRequest({ assetType: 'baler', unitNumber: '', make: 'Harris' }),
    ).toBeNull();
  });

  it('a baler WITH a unit number needs nothing else', () => {
    expect(checkEquipmentRequest({ assetType: 'baler', unitNumber: 'B2' })).toBeNull();
  });
});

describe('format / parse', () => {
  it('writes the fixed four-line shape', () => {
    expect(
      formatEquipmentRequestDescription({
        assetType: 'trailer',
        unitNumber: '#5327',
        make: '  Great   Dane ',
        notes: 'parked at the north fence',
      }),
    ).toBe('Unit #: 5327\nType: Trailer\nMake: Great Dane\nNotes: parked at the north fence');
  });

  it('writes `none` for a missing unit and drops empty optional lines', () => {
    expect(
      formatEquipmentRequestDescription({ assetType: 'baler', unitNumber: '', notes: 'vertical' }),
    ).toBe('Unit #: none\nType: Baler\nNotes: vertical');
  });

  it.each([
    { assetType: 'trailer', unitNumber: '5327', make: 'Great Dane', notes: 'north fence' },
    { assetType: 'forklift', unitNumber: 'F9', make: '', notes: '' },
    { assetType: 'baler', unitNumber: '', make: '', notes: 'line one\nline two' },
    { assetType: 'shear', unitNumber: 'EQ24', make: 'Terex', notes: '' },
  ])('round-trips %j', (fields) => {
    const text = formatEquipmentRequestDescription(fields);
    expect(parseEquipmentRequestDescription(text)).toEqual(fields);
  });

  it.each([
    'Fix and repair trailer: 53489, 5340, 35, 282859 going to Oregon Stores',
    'Yellow Hyster forklift, unit 7, Woodland',
    'Type: Trailer\nUnit #: 5327',
    'Unit #: 5327\nType: Spaceship',
    '',
  ])('legacy / malformed text parses to null: %j', (text) => {
    expect(parseEquipmentRequestDescription(text)).toBeNull();
  });
});

describe('composeEquipmentRequest', () => {
  it('returns the plain-English message for a problem', () => {
    expect(composeEquipmentRequest(trailer('53489, 5340'))).toEqual({
      ok: false,
      problem: 'unit_invalid',
      message: REQUEST_PROBLEM_MESSAGE.unit_invalid,
    });
  });

  it('returns the exact description the server re-parses and accepts', () => {
    const r = composeEquipmentRequest({ ...trailer('32-48'), make: 'Wabash', notes: '' });
    expect(r).toEqual({ ok: true, description: 'Unit #: 32-48\nType: Trailer\nMake: Wabash' });
    if (!r.ok) throw new Error('unreachable');
    const parsed = parseEquipmentRequestDescription(r.description);
    expect(parsed && checkEquipmentRequest(parsed)).toBeNull();
  });
});
