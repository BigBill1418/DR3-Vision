// ADR-0041 amendment (rollup §9) — the LOCKED GP item-code taxonomy (verbatim).

import { describe, expect, it } from 'vitest';
import { GP_ITEM_CODE, MILES_0_MEMBER_CODES, itemCodeForLineCode } from './item-codes';
import { LINE_CODE } from './types';

describe('GP_ITEM_CODE — verbatim strings (spaces are significant, §9)', () => {
  it('exactly the 7 locked codes from the real invoice PDFs', () => {
    expect(GP_ITEM_CODE.location).toBe('LOCATION');
    expect(GP_ITEM_CODE.unitsMo).toBe('UNITSMO');
    expect(GP_ITEM_CODE.reimbo).toBe('REIMBO');
    expect(GP_ITEM_CODE.evento).toBe('EVENTO');
    expect(GP_ITEM_CODE.miles0).toBe('MILES 0'); // embedded space
    expect(GP_ITEM_CODE.fuel).toBe('FUEL');
    expect(GP_ITEM_CODE.oregonMattress).toBe('OREGON MATTRESS'); // embedded space
    expect(Object.keys(GP_ITEM_CODE)).toHaveLength(7);
  });
});

describe('MILES_0_MEMBER_CODES — freight + event_trans + rental (NOT fuel), §9', () => {
  it('is exactly the three aggregating leaves', () => {
    expect(MILES_0_MEMBER_CODES).toContain(LINE_CODE.freight);
    expect(MILES_0_MEMBER_CODES).toContain(LINE_CODE.eventFreight);
    expect(MILES_0_MEMBER_CODES).toContain(LINE_CODE.rentals);
    expect(MILES_0_MEMBER_CODES).not.toContain(LINE_CODE.fuel);
    expect(MILES_0_MEMBER_CODES).toHaveLength(3);
  });
});

describe('itemCodeForLineCode — leaf → GP item code', () => {
  it('processing charges → UNITSMO', () => {
    expect(itemCodeForLineCode(LINE_CODE.processing)).toBe('UNITSMO');
    expect(itemCodeForLineCode(LINE_CODE.midMonthProcessing)).toBe('UNITSMO');
  });
  it('incentives → REIMBO, events → EVENTO', () => {
    expect(itemCodeForLineCode(LINE_CODE.incentives)).toBe('REIMBO');
    expect(itemCodeForLineCode(LINE_CODE.eventMisc)).toBe('EVENTO');
  });
  it('freight/event-freight/rentals → MILES 0; fuel → FUEL', () => {
    expect(itemCodeForLineCode(LINE_CODE.freight)).toBe('MILES 0');
    expect(itemCodeForLineCode(LINE_CODE.eventFreight)).toBe('MILES 0');
    expect(itemCodeForLineCode(LINE_CODE.rentals)).toBe('MILES 0');
    expect(itemCodeForLineCode(LINE_CODE.fuel)).toBe('FUEL');
  });
  it('satellite → OREGON MATTRESS', () => {
    expect(itemCodeForLineCode(LINE_CODE.satellite)).toBe('OREGON MATTRESS');
  });
  it('trade-discount offset + manual → no standalone GP item line (null)', () => {
    expect(itemCodeForLineCode(LINE_CODE.eomOffset)).toBeNull();
    expect(itemCodeForLineCode(LINE_CODE.manual)).toBeNull();
  });
});
