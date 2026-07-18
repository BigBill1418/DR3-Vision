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

// The block-label row ("TRASH", "METAL", …) on a TYPICAL DAY sheet — the row
// where `commodityBlocksForDaySheet` anchors columns. NOTE (§8.2, real files):
// the grid is NOT at a fixed row across every DAY sheet. The "OUTBOUNDS" marker
// (and the block-label row below it) shifts down on sheets that carry extra
// preamble (e.g. DAY0's marker is on row 55, labels row 56). The finalized
// parser therefore LOCATES the grid dynamically off the "OUTBOUNDS" marker
// (section-extractors.ts) rather than trusting this constant; the constant is
// retained for the common-case documentation + the layout unit tests.
export const OUTBOUND_GRID_ROW = 51;

/** Each block occupies an 8-column stride (7 field columns + 1 spacer). */
export const BLOCK_WIDTH = 8;

/** The DAY sheet that uniquely carries the 9th (cotton) block. */
export const COTTON_DAY_SHEET = 'DAY6';

/** Cotton block's first column on DAY6 — CONFIRMED from the real June + July files. */
export const COTTON_START_COL = 68;

/**
 * Header fields for a STANDARD commodity block, left→right — CONFIRMED from the
 * real files (§8.2). Seven fields; the 7th column is labelled "Haul#" on some
 * DAY sheets and "Material#" on others but always holds the material/ticket id.
 * DAY6's cotton block appends an 8th "revenue" column (see `BLOCK_HEADER_FIELDS_COTTON`).
 */
export const BLOCK_HEADER_FIELDS: readonly string[] = [
  'Date',
  'Site',
  'Commodity',
  'Weight',
  'BOL#',
  'DR3#',
  'Haul#',
] as const;

/** DAY6's cotton block carries an extra trailing "revenue" column (§8.2). */
export const BLOCK_HEADER_FIELDS_COTTON: readonly string[] = [
  ...BLOCK_HEADER_FIELDS,
  'revenue',
] as const;

// Workbook order of the 8 standard blocks (left→right in the block-label row).
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

// Column derivation — CONFIRMED from the real files (§8.2):
//   The 8 standard blocks anchor at col 3 (TRASH) on an 8-column stride:
//   3, 11, 19, 27, 35, 43, 51, 59. DAY6's cotton block does NOT continue that
//   stride (which would land on 67); it is shifted to the CONFIRMED col 68.
//   (Earlier ADR-0048 inference used a col-4 anchor — corrected here against the
//   real June + July DAY grids.)
const FIRST_BLOCK_START_COL = 3;

function startColForBlock(blockIndex1Based: number): number {
  return FIRST_BLOCK_START_COL + BLOCK_WIDTH * (blockIndex1Based - 1);
}

/** Block-label text ("TRASH", …) → commodity, in workbook order (+ cotton). */
export const OUTBOUND_BLOCK_LABELS: readonly { label: string; commodity: Commodity }[] = [
  ...STANDARD_BLOCK_COMMODITIES.map((commodity) => ({ label: commodity, commodity })),
  { label: COTTON_COMMODITY, commodity: COTTON_COMMODITY },
];

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
      // Cotton breaks the stride: CONFIRMED at col 68 on DAY6 (the stride-9
      // position would be 67). It also carries the extra trailing "revenue" col.
      startCol: COTTON_START_COL,
      headerFields: BLOCK_HEADER_FIELDS_COTTON,
    });
  }

  return blocks;
}
