import { describe, expect, it } from 'vitest';
import type { Commodity } from '../types';
import {
  BLOCK_HEADER_FIELDS,
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

  it('places the 8 standard blocks on the confirmed 8-col stride anchored to cotton', () => {
    const blocks = commodityBlocksForDaySheet('DAY6');
    // stride 8 starting at col 4 → block 9 (cotton) lands on 68.
    expect(blocks.map((b) => b.startCol)).toEqual([4, 12, 20, 28, 36, 44, 52, 60, 68]);
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
  it('every block carries the 8-field header sequence', () => {
    for (const block of commodityBlocksForDaySheet('DAY6')) {
      expect(block.headerFields).toEqual([
        'Date',
        'Site',
        'Commodity',
        'Weight',
        'BOL# or Check #',
        'DR3#',
        'Haul#',
        'revenue',
      ]);
    }
    expect(BLOCK_HEADER_FIELDS).toHaveLength(8);
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
