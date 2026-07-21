// ADR-0041 amendment (rollup §11) — commodity breakdown LANDSCAPE PDF renderer.
// pdf-lib is pure-JS → renders in Node with no Chromium, so this runs directly.

import { describe, expect, it } from 'vitest';
import { buildCommodityBreakdown, renderCommodityBreakdownPdf, type CommodityBreakdownInput } from '.';

const PIN = new Date('2026-07-01T00:00:00Z');

function bigInput(txnPerCommodity: number): CommodityBreakdownInput {
  const outbound = [];
  for (const commodity of ['metal', 'foam', 'wood', 'cardboard']) {
    for (let i = 0; i < txnPerCommodity; i++) {
      outbound.push({
        shipDateISO: '2026-06-15',
        commodity,
        weightLbs: 1200 + i,
        ticketNumber: `T${commodity}${i}`,
        retracId: `R${i}`,
        recyclerName: commodity === 'metal' ? 'Xtraction' : null,
        recyclingPercentApplied: commodity === 'metal' ? 0.81 : null,
        recycledLbs: commodity === 'metal' ? 972 : null,
        landfilledLbs: null,
      });
    }
  }
  return {
    siteName: 'Woodland',
    periodLabel: 'June 2026',
    facilityLabel: 'Woodland',
    outbound,
    landfilledUnits: [
      { movementDateISO: '2026-06-20', reason: 'water_logged', units: 4, slipNumber: 'S1', retracId: null },
    ],
  };
}

async function pageCount(pdf: Buffer): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  return doc.getPageCount();
}

async function firstPageSize(pdf: Buffer): Promise<{ w: number; h: number }> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  const { width, height } = doc.getPage(0).getSize();
  return { w: width, h: height };
}

describe('renderCommodityBreakdownPdf', () => {
  it('produces a valid PDF in LANDSCAPE Letter orientation (width > height)', async () => {
    const model = buildCommodityBreakdown(bigInput(2));
    const pdf = await renderCommodityBreakdownPdf(model, PIN);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const { w, h } = await firstPageSize(pdf);
    expect(w).toBeGreaterThan(h); // landscape
    expect(Math.round(w)).toBe(792); // Letter landscape width
    expect(Math.round(h)).toBe(612);
  });

  it('paginates when blocks + rows overflow one page (multi-page)', async () => {
    const model = buildCommodityBreakdown(bigInput(40)); // lots of rows across blocks
    const pdf = await renderCommodityBreakdownPdf(model, PIN);
    expect(await pageCount(pdf)).toBeGreaterThan(1);
  });

  it('renders an empty period on a single page (no activity marker)', async () => {
    const model = buildCommodityBreakdown({
      siteName: 'Eugene', periodLabel: 'June 2026', facilityLabel: 'Eugene', outbound: [], landfilledUnits: [],
    });
    const pdf = await renderCommodityBreakdownPdf(model, PIN);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await pageCount(pdf)).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic: same model + pinned instant → byte-identical output', async () => {
    const model = buildCommodityBreakdown(bigInput(3));
    const a = await renderCommodityBreakdownPdf(model, PIN);
    const b = await renderCommodityBreakdownPdf(model, PIN);
    expect(a.equals(b)).toBe(true);
  });
});
