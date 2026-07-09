// ADR-0048 / ADR-0049 — DAY-sheet outbound-by-commodity grid layout.
//
// WHY this exists: each DAY sheet (DAY0..DAY31) carries an OUTBOUND-BY-COMMODITY
// grid starting at row 51 — 8 commodity blocks laid out side-by-side, each 8
// columns wide (PR#87 §1.2). DAY6 is the exception: it carries a NINTH block,
// COTTON, at cols 68–75. The 2026-07-09 rollup (§3.1) confirmed this 9th block is
// present in BOTH the June AND July workbooks, so it is a PERMANENT template
// feature — not a June anomaly. The parser "expects the 9th block on DAY6"
// (rollup §8.1 item 2); this module is the single source of truth for where each
// block sits and which commodity it holds.
//
// Cotton lands in the daily-log-9 taxonomy (see src/lib/audit/types.ts
// `Commodity`), and DAY6's 9-block grid aligns exactly with ADR-0037 Addendum B's
// nine captured commodities.

import type { Commodity } from '../types';

/** One outbound commodity block within a DAY sheet's row-51 grid. */
export interface CommodityBlock {
  /** daily-log-9 commodity (lowercase, from the repo `Commodity` type). */
  commodity: Commodity;
  /** 1-based first column of this block (Date column). */
  startCol: number;
  /** Ordered header fields, left→right, occupying `startCol`..`startCol+7`. */
  headerFields: readonly string[];
}

/** The row where every DAY sheet's outbound-by-commodity grid begins (PR#87 §1.2). */
export const OUTBOUND_GRID_ROW = 51;

/** Each block is 8 columns wide (PR#87 §3.2). */
export const BLOCK_WIDTH = 8;

/** The DAY sheet that uniquely carries the 9th (cotton) block. */
export const COTTON_DAY_SHEET = 'DAY6';

/** Cotton block's first column — CONFIRMED from real-file analysis (rollup §3.1 / PR#87 §3.2). */
export const COTTON_START_COL = 68;

/**
 * Header fields for every commodity block, left→right (PR#87 §3.2). Identical
 * across all blocks and all DAY sheets.
 */
export const BLOCK_HEADER_FIELDS: readonly string[] = [
  'Date',
  'Site',
  'Commodity',
  'Weight',
  'BOL# or Check #',
  'DR3#',
  'Haul#',
  'revenue',
] as const;

// Workbook order of the 8 standard blocks (PR#87 §1.2 / §3.2 row-51 sequence).
// Values are the repo `Commodity` (lowercase daily-log-9) taxonomy.
const STANDARD_BLOCK_COMMODITIES: readonly Commodity[] = [
  'trash',
  'metal',
  'wood',
  'foam',
  'toppers',
  'cardboard',
  'plastic',
  'shoddy',
] as const;

// The 9th block, present only on DAY6 (permanent template feature — rollup §3.1).
const COTTON_COMMODITY: Commodity = 'cotton';

// Column derivation:
//   COTTON is CONFIRMED at col 68. The block-i start column follows
//   4 + 8*(i-1) (i is 1-based), which places block 9 (cotton) at 4 + 8*8 = 68 —
//   consistent with the confirmed cotton anchor. The 8 standard blocks' start
//   columns are therefore INFERRED from that same stride.
// TODO(§8.2, real-file finalization): confirm the 8 standard blocks' start
//   columns against the real DAY-sheet grid when the workbooks land. Cotton's
//   anchor (68) is proven; the stride below is inferred and cross-checks to it.
const FIRST_BLOCK_START_COL = 4;

function startColForBlock(blockIndex1Based: number): number {
  return FIRST_BLOCK_START_COL + BLOCK_WIDTH * (blockIndex1Based - 1);
}

/** True for a canonical DAY sheet name (`DAY0`..`DAY31`, case-insensitive). */
export function isDaySheet(sheetName: string): boolean {
  return /^DAY\d{1,2}$/i.test(sheetName.trim());
}

/**
 * The ordered outbound commodity blocks expected on `sheetName`.
 *
 * Returns 8 blocks for every DAY sheet, plus a 9th COTTON block (last, at
 * `startCol` 68) for DAY6 only. Non-DAY sheet names return an empty array.
 */
export function commodityBlocksForDaySheet(sheetName: string): CommodityBlock[] {
  if (!isDaySheet(sheetName)) return [];

  const blocks: CommodityBlock[] = STANDARD_BLOCK_COMMODITIES.map((commodity, i) => ({
    commodity,
    startCol: startColForBlock(i + 1),
    headerFields: BLOCK_HEADER_FIELDS,
  }));

  if (sheetName.trim().toUpperCase() === COTTON_DAY_SHEET) {
    blocks.push({
      commodity: COTTON_COMMODITY,
      startCol: COTTON_START_COL, // 4 + 8*8 = 68 (confirmed anchor)
      headerFields: BLOCK_HEADER_FIELDS,
    });
  }

  return blocks;
}
