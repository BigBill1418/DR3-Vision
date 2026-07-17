// ADR-0048/0049 §8.2 — end-to-end coverage of the semantic (real-file) parse
// path: parseWorkbook → classifyWorkbookSheets → section-extractors, on a
// synthetic workbook mirroring the REAL Woodland sheet-name/label/grid SHAPE
// (invented data). Complements parser.test.ts (legacy synthetic layout).

import { describe, expect, it } from 'vitest';
import { parseWorkbook } from './parser';
import { decodeStagingRows, type StagingRowInput } from '../workbook-promotion';
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
    // 2 trans-charge + 1 non-program inbound loads.
    expect(s['inbound']).toBe(3);
    // 8 standard commodity blocks on DAY1 + 9 (incl cotton) on DAY6.
    expect(s['outbound']).toBe(17);
    expect(s['daily_close']).toBe(2);
    expect(s['dropoff']).toBe(1);
    expect(s['opening_inventory']).toBe(1);
    expect(s['summary']).toBeGreaterThan(0);
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
    expect(cand.inbound).toHaveLength(3);
    expect(cand.outbound).toHaveLength(17);
    expect(cand.dailyCloses).toHaveLength(2);
    expect(cand.dropoffs).toHaveLength(1);
    expect(cand.opening).not.toBeNull();
    // Non-program inbound load carries its explicit split.
    expect(cand.inbound.some((i) => i.nonProgramUnits === 20 && i.programUnits === 0)).toBe(true);
  });

  it('surfaces the billing-affecting flags for operator review', async () => {
    const parsed = await parseWorkbook(await buildWoodlandDailyLogWorkbook());
    const joined = parsed.flags.join('\n');
    expect(joined).toMatch(/inbound-completeness/);
    expect(joined).toMatch(/nonprogram/i);
    expect(joined).toMatch(/AUTHORITATIVE month-close/);
  });
});
