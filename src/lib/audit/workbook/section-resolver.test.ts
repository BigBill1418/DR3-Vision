import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  cellNumber,
  classifyWorkbookSheets,
  readSectionNumbers,
  readSectionRow,
  resolveSectionType,
  ROW2_LABEL_CONFIRMATIONS,
} from './section-resolver';
import {
  buildSingleSheetWorkbook,
  buildWoodlandClassificationWorkbook,
  pick,
  type SampleRowsFixture,
} from './__fixtures__/build-woodland-workbook';

const FIXTURE = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/adr-0048/sample-rows.json'), 'utf8'),
) as SampleRowsFixture;

async function loadWorkbook(buf: ExcelJS.Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ExcelJS.Buffer);
  return wb;
}

describe('classifyWorkbookSheets — real §5 fixture bytes', () => {
  it('classifies every Woodland sheet (June + July naming) correctly', async () => {
    const wb = await loadWorkbook(await buildWoodlandClassificationWorkbook(FIXTURE));
    const map = classifyWorkbookSheets(wb);

    // June name AND July name (month prefix dropped) both → inb_trans_charges.
    expect(map.get('June2026 inb trans charges')).toBe('inb_trans_charges');
    expect(map.get('inb trans charges')).toBe('inb_trans_charges');
    // Name-fallback resolutions.
    expect(map.get('NonProgram')).toBe('nonprogram');
    expect(map.get('variables')).toBe('variables');
    // Header-signature resolution.
    expect(map.get('Fuel')).toBe('fuel');
    // Name-only DAY resolution.
    expect(map.get('DAY6')).toBe('day');
    // Non-catalogued shape never throws — returns 'unknown'.
    expect(map.get('ScratchPad')).toBe('unknown');
  });
});

describe('resolveSectionType — CRITICAL cross-month correctness (rollup §3.2)', () => {
  it('resolves June and July tab names to the same semantic type', () => {
    expect(resolveSectionType({ name: 'June2026 inb trans charges' })).toBe('inb_trans_charges');
    expect(resolveSectionType({ name: 'inb trans charges' })).toBe('inb_trans_charges');
    expect(resolveSectionType({ name: 'June26 Commodities' })).toBe('commodities');
    expect(resolveSectionType({ name: 'Commodities' })).toBe('commodities');
    expect(resolveSectionType({ name: 'June2026All' })).toBe('all_inbounds');
    expect(resolveSectionType({ name: 'July2026All' })).toBe('all_inbounds');
  });
});

describe('resolveSectionType — name fallback (prefix stripping)', () => {
  it('strips spaced and glued month/year prefixes', () => {
    expect(resolveSectionType({ name: 'June26 inb no trans charge' })).toBe('inb_no_trans_charge');
    expect(resolveSectionType({ name: 'June26 incentive_unpaid' })).toBe('incentive_unpaid');
    expect(resolveSectionType({ name: 'June2026 Renovation' })).toBe('renovation');
    expect(resolveSectionType({ name: 'June26 Processed' })).toBe('processed');
    expect(resolveSectionType({ name: 'Container Rentals' })).toBe('container_rentals');
    expect(resolveSectionType({ name: 'Trans Summary' })).toBe('trans_summary');
    expect(resolveSectionType({ name: 'Summary' })).toBe('summary');
    expect(resolveSectionType({ name: 'Events' })).toBe('events');
    expect(resolveSectionType({ name: 'list' })).toBe('list');
  });

  it('returns unknown for an uncatalogued name (never throws)', () => {
    expect(resolveSectionType({ name: 'RandomTab' })).toBe('unknown');
    expect(resolveSectionType({ name: '' })).toBe('unknown');
  });
});

describe('resolveSectionType — row-2 section label match (durable signal)', () => {
  it('matches the confirmed INBOUND WITH TRANS CHARGE label regardless of sheet name', () => {
    expect(
      resolveSectionType({
        name: 'a-name-that-drifted', // name intentionally unrecognizable
        row2: ['INBOUND WITH TRANS CHARGE - Woodland', null, null],
      }),
    ).toBe('inb_trans_charges');
  });

  it('prefers the more-specific trans_summary label over the summary superset', () => {
    expect(resolveSectionType({ name: 'x', row2: ['Transportation Summary - Woodland'] })).toBe(
      'trans_summary',
    );
    expect(resolveSectionType({ name: 'x', row2: ['Woodland- Summary MID-MONTH'] })).toBe(
      'summary',
    );
  });

  it('does not misfire on plain column-header words in row 2', () => {
    // A header-only row 2 (NonProgram-shaped) must fall through to name/signature.
    expect(
      resolveSectionType({
        name: 'NonProgram',
        row2: ['Date', 'Site', 'commodity', 'inbound unit #', 'trans charge'],
      }),
    ).toBe('nonprogram');
  });

  it('flags only inb_trans_charges as confirmed; the rest await §8.2 reconciliation', () => {
    expect(ROW2_LABEL_CONFIRMATIONS.get('inb_trans_charges')).toBe(true);
    expect(ROW2_LABEL_CONFIRMATIONS.get('nonprogram')).toBe(false);
    expect(ROW2_LABEL_CONFIRMATIONS.get('summary')).toBe(false);
  });
});

describe('resolveSectionType — header signature match', () => {
  it('classifies by the freight/fuel/total triad even when the name is unknown', () => {
    expect(
      resolveSectionType({
        name: 'mystery',
        headerRows: {
          3: ['Date', 'Site', 'inbound unit #', 'Freight Rate', 'Fuel Surcharge', 'Total'],
        },
      }),
    ).toBe('inb_trans_charges');
  });
});

describe('fixture round-trip — known-good rows (rollup §8.1 item 7)', () => {
  it('reads back the first June inb-trans row exactly', async () => {
    const wb = await loadWorkbook(await buildSingleSheetWorkbook(pick(FIXTURE, 'june_inb_trans')));
    const ws = wb.getWorksheet('June2026 inb trans charges')!;
    // header row 3 → first data row 4.
    const texts = readSectionRow(ws, 4, 13);
    const nums = readSectionNumbers(ws, 4, 13);
    expect(texts[0]).toMatch(/^2026-06-19/); // Date
    expect(texts[1]).toBe('Bass Hill Landfill - LRSWMA'); // Site
    expect(nums[2]).toBe(52); // inbound unit #
    expect(nums[12]).toBeCloseTo(1619.1375384615385, 9); // Total
  });

  it('reads back the first Fuel weekly price row exactly', async () => {
    const wb = await loadWorkbook(await buildSingleSheetWorkbook(pick(FIXTURE, 'june_fuel')));
    const ws = wb.getWorksheet('Fuel')!;
    // header row 2 → first data row 3.
    const row = ws.getRow(3);
    expect(readSectionRow(ws, 3, 3)[0]).toMatch(/^2026-03-02/); // Begin Date
    expect(readSectionRow(ws, 3, 3)[1]).toMatch(/^2026-03-08/); // End Date
    expect(cellNumber(row.getCell(3).value)).toBeCloseTo(4.534, 9); // Price per Gallon
  });
});
