import { describe, expect, it } from 'vitest';
import { columnLetterToNumber, parseWorkbook } from './parser';
import { buildDriftWorkbook, buildGenerationWorkbook } from './__fixtures__/build-workbook';

describe('columnLetterToNumber', () => {
  it('maps column letters to 1-based indices', () => {
    expect(columnLetterToNumber('A')).toBe(1);
    expect(columnLetterToNumber('B')).toBe(2);
    expect(columnLetterToNumber('Z')).toBe(26);
    expect(columnLetterToNumber('AA')).toBe(27);
  });
});

describe('parseWorkbook — template generations (Janette Q8)', () => {
  it('detects no_calc (stored constants, no detail ranges)', async () => {
    const parsed = await parseWorkbook(await buildGenerationWorkbook('no_calc'));
    expect(parsed.templateGeneration).toBe('no_calc');
    expect(parsed.summaryFigures).toHaveLength(2);
  });

  it('detects calc (figures reference detail ranges)', async () => {
    const parsed = await parseWorkbook(await buildGenerationWorkbook('calc'));
    expect(parsed.templateGeneration).toBe('calc');
    expect(parsed.detailAmountsByFigure.get('Fuel')).toHaveLength(60);
  });

  it('detects eod_carryover (Inventory sheet present)', async () => {
    const parsed = await parseWorkbook(await buildGenerationWorkbook('eod_carryover'));
    expect(parsed.templateGeneration).toBe('eod_carryover');
  });
});

describe('parseWorkbook — provenance + rollups', () => {
  it('stages every parsed record with tab/row/col provenance', async () => {
    const parsed = await parseWorkbook(await buildGenerationWorkbook('calc'));
    for (const row of parsed.stagingRows) {
      expect(row.provenance.tab).toBeTruthy();
      expect(row.provenance.row).toBeGreaterThan(0);
      expect(row.provenance.col).toBeTruthy();
    }
    const outbound = parsed.outbound;
    expect(outbound).toContainEqual(expect.objectContaining({ commodity: 'toppers', subCategory: 'renovation' }));
  });

  it('captures the FULL detail block including rows outside the template SUM range', async () => {
    const parsed = await parseWorkbook(await buildDriftWorkbook());
    const fuel = parsed.detailAmountsByFigure.get('Fuel')!;
    // 71..140 = 70 rows; 131..140 (10 rows) fall outside the 71..130 range.
    expect(fuel).toHaveLength(70);
    expect(fuel.filter((a) => a.outsideRange)).toHaveLength(10);
  });
});
