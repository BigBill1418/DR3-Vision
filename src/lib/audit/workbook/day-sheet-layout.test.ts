import { describe, expect, it } from 'vitest';
import type { Commodity } from '../types';
import {
  BLOCK_HEADER_FIELDS,
  BLOCK_HEADER_FIELDS_COTTON,
  COTTON_START_COL,
  commodityBlocksForDaySheet,
  isDaySheet,
} from './day-sheet-layout';

const DAILY_LOG_9: readonly Commodity[] = [
  'trash',
  'toppers',
  'foam',
  'metal',
  'wood',
  'cardboard',
  'plastic',
  'shoddy',
  'cotton',
];

describe('commodityBlocksForDaySheet — DAY6 9th (cotton) block', () => {
  it('returns 9 blocks for DAY6 with cotton last at startCol 68', () => {
    const blocks = commodityBlocksForDaySheet('DAY6');
    expect(blocks).toHaveLength(9);
    const cotton = blocks[8]!;
    expect(cotton.commodity).toBe('cotton');
    expect(cotton.startCol).toBe(COTTON_START_COL);
    expect(cotton.startCol).toBe(68);
  });

  it('preserves the workbook block order for the 8 standard blocks', () => {
    const blocks = commodityBlocksForDaySheet('DAY6');
    expect(blocks.slice(0, 8).map((b) => b.commodity)).toEqual([
      'trash',
      'metal',
      'wood',
      'foam',
      'toppers',
      'cardboard',
      'plastic',
      'shoddy',
    ]);
  });

  it('places the 8 standard blocks on the confirmed col-3 8-col stride, cotton at 68', () => {
    const blocks = commodityBlocksForDaySheet('DAY6');
    // §8.2 real-file correction: standard blocks anchor at col 3 (TRASH) on an
    // 8-col stride → 3,11,19,27,35,43,51,59. Cotton breaks the stride at the
    // CONFIRMED col 68 (the stride-9 position would be 67). Earlier ADR-0048
    // used a col-4 inference; corrected against the real June + July DAY grids.
    expect(blocks.map((b) => b.startCol)).toEqual([3, 11, 19, 27, 35, 43, 51, 59, 68]);
  });
});

describe('commodityBlocksForDaySheet — non-DAY6 DAY sheets', () => {
  it('DAY1 and DAY17 return exactly 8 blocks, no cotton', () => {
    for (const name of ['DAY1', 'DAY17', 'DAY0', 'DAY31']) {
      const blocks = commodityBlocksForDaySheet(name);
      expect(blocks).toHaveLength(8);
      expect(blocks.some((b) => b.commodity === 'cotton')).toBe(false);
    }
  });

  it('returns an empty array for a non-DAY sheet name', () => {
    expect(commodityBlocksForDaySheet('Commodities')).toEqual([]);
    expect(commodityBlocksForDaySheet('Fuel')).toEqual([]);
  });
});

describe('commodityBlocksForDaySheet — header fields + taxonomy', () => {
  it('standard blocks carry the 7-field header; DAY6 cotton adds an 8th "revenue" col', () => {
    // §8.2 real-file correction: standard commodity blocks are 7 fields (no
    // "revenue"); only DAY6's cotton block appends "revenue" (col 75).
    const blocks = commodityBlocksForDaySheet('DAY6');
    const standard = blocks.slice(0, 8);
    const cotton = blocks[8]!;
    for (const block of standard) {
      expect(block.headerFields).toEqual([
        'Date',
        'Site',
        'Commodity',
        'Weight',
        'BOL#',
        'DR3#',
        'Haul#',
      ]);
    }
    expect(cotton.headerFields).toEqual(BLOCK_HEADER_FIELDS_COTTON);
    expect(BLOCK_HEADER_FIELDS).toHaveLength(7);
    expect(BLOCK_HEADER_FIELDS_COTTON).toHaveLength(8);
  });

  it('every block commodity is a valid daily-log-9 value', () => {
    for (const block of commodityBlocksForDaySheet('DAY6')) {
      expect(DAILY_LOG_9).toContain(block.commodity);
    }
  });
});

describe('isDaySheet', () => {
  it('matches DAY0..DAY31 (case-insensitive) and rejects others', () => {
    expect(isDaySheet('DAY0')).toBe(true);
    expect(isDaySheet('DAY6')).toBe(true);
    expect(isDaySheet('day31')).toBe(true);
    expect(isDaySheet('Commodities')).toBe(false);
    expect(isDaySheet('DAYS')).toBe(false);
  });
});
