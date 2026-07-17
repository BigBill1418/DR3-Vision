// ADR-0048/0049 §8.2 — end-to-end coverage of the semantic (real-file) parse
// path: parseWorkbook → classifyWorkbookSheets → section-extractors, on a
// synthetic workbook mirroring the REAL Woodland sheet-name/label/grid SHAPE
// (invented data). Complements parser.test.ts (legacy synthetic layout).

import { describe, expect, it } from 'vitest';
import { parseWorkbook } from './parser';
import {
  decodeStagingRows,
  computeCloseFromCandidates,
  type StagingRowInput,
} from '../workbook-promotion';
import type { SiteAliasResolver } from '../types';
import { buildWoodlandDailyLogWorkbook } from './__fixtures__/build-woodland-workbook';

const resolver: SiteAliasResolver = {
  resolve: (name) => ({ siteId: 'woodland', canonicalName: name, isNonProgram: false }),
};

function sections(rows: { section: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.section ?? 'null'] = (out[r.section ?? 'null'] ?? 0) + 1;
  return out;
}

describe('parseWorkbook — real Woodland semantic path (§8.2)', () => {
  it('routes a Woodland workbook to the semantic extractor (not the legacy path)', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    expect(parsed.templateGeneration).toBe('woodland_daily');
    expect(parsed.stagingRows.length).toBeGreaterThan(0);
    expect(parsed.sheetTypes.get('June2026 inb trans charges')).toBe('inb_trans_charges');
    expect(parsed.sheetTypes.get('DAY6')).toBe('day');
  });

  it('stages inbound / outbound / daily_close / dropoff / opening / summary sections', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    const s = sections(parsed.stagingRows);
    // Inbound sourced from the DAY per-day INBOUND grid: DAY1 (2) + DAY6 (2)
    // "inbound units" loads; the DAY6 unpaid-drop-off row routes to dropoff.
    expect(s['inbound']).toBe(4);
    expect(s['dropoff']).toBe(1);
    // 8 standard commodity blocks on DAY1 + 9 (incl cotton) on DAY6.
    expect(s['outbound']).toBe(17);
    expect(s['daily_close']).toBe(2);
    expect(s['opening_inventory']).toBe(1);
    expect(s['summary']).toBeGreaterThan(0);
  });

  it('sources inbound from the DAY grid (category sheets are evidence, not promoted)', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    // The category tab is classified + staged as evidence (section 'detail'),
    // never as a promotable inbound row — no double-count against the DAY grid.
    expect(parsed.sheetTypes.get('June2026 inb trans charges')).toBe('inb_trans_charges');
    const catRows = parsed.stagingRows.filter(
      (r) => r.tabName === 'June2026 inb trans charges' && r.section === 'inbound',
    );
    expect(catRows).toHaveLength(0);
    // Every promotable inbound row comes from a DAY sheet.
    const inboundRows = parsed.stagingRows.filter((r) => r.section === 'inbound');
    expect(inboundRows.every((r) => /^DAY\d+$/i.test(r.tabName))).toBe(true);
  });

  it('extracts DAY6 cotton (9th block at col 68) as a cotton outbound row', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    expect(parsed.outbound.some((o) => o.commodity === 'cotton')).toBe(true);
  });

  it('reads the AUTHORITATIVE close balance from the DAY Ending-inventory cell', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    // DAY6 ending inventory (1523) is the highest-numbered day's Ending inventory.
    expect(parsed.closeBalance?.value).toBe(1523);
    expect(parsed.closeBalance?.provenance.tab).toBe('DAY6');
  });

  it('emits promotion-consumable StagingRows the promotion decode accepts', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    const rows: StagingRowInput[] = parsed.stagingRows.map((r) => ({
      section: r.section,
      raw_value: r.rawValue,
      numeric_value: r.numericValue,
      site_name_raw: r.siteNameRaw,
      provenance: r.provenance,
    }));
    const scope = {
      siteId: 'woodland',
      from: '2026-06-01',
      to: '2026-06-30',
      expectedCloseTotal: null,
    };
    const cand = decodeStagingRows(rows, scope, resolver);
    expect(cand.inbound).toHaveLength(4);
    expect(cand.outbound).toHaveLength(17);
    expect(cand.dailyCloses).toHaveLength(2);
    expect(cand.dropoffs).toHaveLength(1);
    expect(cand.opening).not.toBeNull();
  });

  it('flow-recomputes the close to the authoritative workbook close (reconciles)', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    const rows: StagingRowInput[] = parsed.stagingRows.map((r) => ({
      section: r.section,
      raw_value: r.rawValue,
      numeric_value: r.numericValue,
      site_name_raw: r.siteNameRaw,
      provenance: r.provenance,
    }));
    const scope = {
      siteId: 'woodland',
      from: '2026-06-01',
      to: '2026-06-30',
      expectedCloseTotal: null,
    };
    const close = computeCloseFromCandidates(decodeStagingRows(rows, scope, resolver));
    // opening 1500 + DAY inbound 145 - stripped 122 = 1523 = DAY6 ending inventory.
    expect(close.total.toString()).toBe('1523');
    expect(parsed.closeBalance?.value).toBe(1523);
  });

  it('surfaces the billing-affecting flags for operator review', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    const joined = parsed.flags.join('\n');
    expect(joined).toMatch(/inbound-sourced-from-DAY-grid/);
    expect(joined).toMatch(/RECONCILES EXACTLY/);
    expect(joined).toMatch(/AUTHORITATIVE month-close/);
  });
});
