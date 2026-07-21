// ADR-0041 amendment (rollup §11) — the commodity-breakdown LANDSCAPE PDF.
//
// Renders {@link CommodityBreakdownModel} to a multi-page LETTER LANDSCAPE PDF:
// a header, then each of the taxonomy blocks (facility header once per block,
// per-transaction rows, per-block totals), flowing down the page and paginating
// when a block runs off the bottom. §11's source was a wide spreadsheet with one
// block per COLUMN range; a paginated document renders those same discrete blocks
// as stacked titled sub-tables — the document form of the same taxonomy. This is
// a documented rendering choice (§11).
//
// PDF STACK CHOICE: pdf-lib (approved since ADR-0046 Amendment 4), NOT the
// Playwright print path used by cor/bonus. Rationale: pdf-lib is pure-JS and
// renders deterministically in Node with NO headless Chromium — so this renderer
// is unit-testable directly (assert page count / orientation / valid bytes)
// without a browser, and it needs no new internal print route + middleware
// allowlist. Determinism: metadata dates are pinned to `generatedAt` so a given
// model renders byte-identical output (reproducible sha256).

import type { CommodityBlockModel, CommodityBreakdownModel } from './breakdown';

// Letter landscape, points (11in × 8.5in).
const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;

const TITLE_SIZE = 16;
const BLOCK_TITLE_SIZE = 11;
const META_SIZE = 8;
const CELL_SIZE = 8;
const ROW_H = 13;
const HEADER_ROW_H = 15;

/** Truncate a cell to fit `maxW` at `size`, appending "…" when cut. */
function fit(text: string, measure: (t: string) => number, maxW: number): string {
  if (measure(text) <= maxW) return text;
  let s = text;
  while (s.length > 1 && measure(`${s}…`) > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

/** Equal-ish column x-offsets + widths across the content area. */
function columnLayout(colCount: number): { x: number[]; w: number[] } {
  const w = CONTENT_W / colCount;
  const x: number[] = [];
  const widths: number[] = [];
  for (let i = 0; i < colCount; i++) {
    x.push(MARGIN + i * w);
    widths.push(w);
  }
  return { x, w: widths };
}

/**
 * Render the commodity-breakdown PDF. Returns the PDF bytes. `generatedAt` pins
 * the metadata so output is reproducible (defaults to the Unix epoch for a fully
 * deterministic build when the caller does not supply the instant).
 */
export async function renderCommodityBreakdownPdf(
  model: CommodityBreakdownModel,
  generatedAt: Date = new Date(0),
): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0, 0.32, 0.3);
  const ink = rgb(0.07, 0.07, 0.07);
  const zebra = rgb(0.95, 0.96, 0.96);
  const headerFill = rgb(0.88, 0.91, 0.9);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  // ── Document header ──────────────────────────────────────────────────────
  page.drawText('Monthly Commodity Breakdown', { x: MARGIN, y: y - TITLE_SIZE, size: TITLE_SIZE, font: bold, color: green });
  y -= TITLE_SIZE + 6;
  page.drawText(`${model.siteName}  ·  ${model.periodLabel}`, { x: MARGIN, y: y - META_SIZE, size: META_SIZE + 1, font, color: ink });
  y -= META_SIZE + 14;
  if (!model.hasActivity) {
    page.drawText('No outbound commodity or landfilled-unit activity for this period.', {
      x: MARGIN, y: y - CELL_SIZE, size: CELL_SIZE + 1, font, color: ink,
    });
  }

  const drawBlock = (block: CommodityBlockModel) => {
    const { x, w } = columnLayout(block.columns.length);
    const rowsToDraw = block.empty ? 1 : block.rows.length;
    // Space needed for title + facility + col header + rows + totals.
    const needed = BLOCK_TITLE_SIZE + 6 + META_SIZE + 6 + HEADER_ROW_H + rowsToDraw * ROW_H + ROW_H + 16;
    if (y - needed < MARGIN) newPage();

    // Block title.
    page.drawText(block.title, { x: MARGIN, y: y - BLOCK_TITLE_SIZE, size: BLOCK_TITLE_SIZE, font: bold, color: green });
    y -= BLOCK_TITLE_SIZE + 4;
    // Facility header (§11 — once per block).
    page.drawText(`Facility: ${block.facilityLabel}`, { x: MARGIN, y: y - META_SIZE, size: META_SIZE, font, color: ink });
    y -= META_SIZE + 6;

    // Column header row.
    page.drawRectangle({ x: MARGIN, y: y - HEADER_ROW_H, width: CONTENT_W, height: HEADER_ROW_H, color: headerFill });
    block.columns.forEach((c, i) => {
      page.drawText(fit(c, (t) => bold.widthOfTextAtSize(t, CELL_SIZE), w[i]! - 6), {
        x: x[i]! + 3, y: y - HEADER_ROW_H + 4, size: CELL_SIZE, font: bold, color: ink,
      });
    });
    y -= HEADER_ROW_H;

    // Data rows (or an empty marker).
    if (block.empty) {
      page.drawText('— no activity for this period —', { x: MARGIN + 3, y: y - ROW_H + 4, size: CELL_SIZE, font, color: ink });
      y -= ROW_H;
    } else {
      block.rows.forEach((row, ri) => {
        if (y - ROW_H < MARGIN) {
          newPage();
          // Repeat the column header on the continued page.
          page.drawRectangle({ x: MARGIN, y: y - HEADER_ROW_H, width: CONTENT_W, height: HEADER_ROW_H, color: headerFill });
          block.columns.forEach((c, i) => {
            page.drawText(fit(c, (t) => bold.widthOfTextAtSize(t, CELL_SIZE), w[i]! - 6), {
              x: x[i]! + 3, y: y - HEADER_ROW_H + 4, size: CELL_SIZE, font: bold, color: ink,
            });
          });
          y -= HEADER_ROW_H;
        }
        if (ri % 2 === 1) {
          page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: CONTENT_W, height: ROW_H, color: zebra });
        }
        row.forEach((cell, i) => {
          page.drawText(fit(cell, (t) => font.widthOfTextAtSize(t, CELL_SIZE), w[i]! - 6), {
            x: x[i]! + 3, y: y - ROW_H + 4, size: CELL_SIZE, font, color: ink,
          });
        });
        y -= ROW_H;
      });
    }

    // Totals row.
    const totalsText = block.totals.map((t) => `${t.label}: ${t.value}`).join('    ');
    page.drawText(totalsText, { x: MARGIN + 3, y: y - ROW_H + 4, size: CELL_SIZE, font: bold, color: green });
    y -= ROW_H + 12;
  };

  for (const block of model.blocks) drawBlock(block);

  doc.setProducer('DR3-Vision');
  doc.setTitle(`Commodity Breakdown — ${model.siteName} ${model.periodLabel}`);
  doc.setCreationDate(generatedAt);
  doc.setModificationDate(generatedAt);
  return Buffer.from(await doc.save());
}
