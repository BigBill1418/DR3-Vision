// ADR-0067 Amendment 8 — header-row detection.
//
// The three fixtures that matter are the three REAL documents the 2026-07-30
// audit measured, reproduced here from the header strings it recorded. The old
// behaviour (first non-empty row) is wrong on all three; each test asserts the
// row that actually holds column names.
//
// Every guard was falsified before being kept.

import { describe, expect, it } from 'vitest';
import { detectHeaderRow } from './header-detect';

describe('detectHeaderRow — the three live documents', () => {
  it('skips the merged title on the Woodland trailer list', () => {
    const rows = [
      ['Woodland Trailer List 2025', '', '', '', ''],
      ['Trailer #', 'Carrier', 'Status', 'Location', 'Last Moved'],
      ['T-101', 'MRC', 'Loaded', 'Dock 3', '2026-07-20'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBe(2);
    expect(d.headers).toEqual(['Trailer #', 'Carrier', 'Status', 'Location', 'Last Moved']);
    expect(d.titleRows).toEqual(['Woodland Trailer List 2025']);
    expect(d.confidence).toBe('strong');
  });

  it('skips the TEREX maintenance-log title', () => {
    const rows = [
      ['TEREX MACHINE MAINTENANCE LOG', '', '', ''],
      ['Date', 'Machine', 'Hours', 'Work Performed'],
      ['2026-07-01', 'TX-9', '1204', 'Oil change'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBe(2);
    expect(d.headers).toContain('Machine');
    expect(d.confidence).toBe('strong');
  });

  it('finds row FOUR on the commodity tracker — three stacked bands above it', () => {
    // Taken from the REAL workbook pulled out of R2 on 2026-07-31, not from the
    // audit's summary of it. This is the case that proves the fix cannot be
    // "assume row 2": the sheet carries a title row, then TWO grouping bands
    // (commodity, then vendor-per-commodity), and only then the column names.
    const rows = [
      ['2026', 'Commodity Audit (against Vendor Invoices)  WOODLAND ', '', '', '', '', ''],
      ['METAL', '', '', 'WOOD', '', '', 'TOPPERS'],
      ['METAL - GreenZone', '', '', 'WOOD- Biomass', '', '', 'TOPPERS - All Vendors'],
      ['Audited', 'Initials', 'Date', '2nd Audit', 'Initials', 'Date', 'Audited'],
      ['x', 'KR', '2026-07-01', '', '', '', 'x'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBe(4);
    expect(d.headers).toContain('Audited');
    expect(d.headers).toContain('2nd Audit');
    // The bands are kept — they are what says WHICH commodity a column group is
    // about, and discarding them would leave six identical 'Audited' columns.
    expect(d.titleRows).toHaveLength(3);
    expect(d.titleRows[1]).toContain('METAL');
    expect(d.confidence).toBe('strong');
  });
});

describe('detectHeaderRow — it detects rather than assuming a fixed row', () => {
  it('takes row 1 when the header really IS on row 1', () => {
    // The fix must not become "always skip a row".
    const rows = [
      ['Date', 'Units', 'Site'],
      ['2026-07-01', '150', 'Woodland'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBe(1);
    expect(d.titleRows).toEqual([]);
    // `strong` matters as much as the index: a variant that always skips one row
    // still lands on row 1 here VIA THE WEAK FALLBACK, so asserting only the index
    // lets "assume row 2" pass. The confidence is what distinguishes "found it"
    // from "gave up and took the widest row".
    expect(d.confidence).toBe('strong');
  });

  it('handles TWO stacked title rows', () => {
    const rows = [
      ['DR3 Vision', '', '', ''],
      ['Woodland — July 2026', '', '', ''],
      ['Day', 'Program', 'Non-program', 'Ticket'],
      ['1', '150', '25', 'M-1'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBe(3);
    expect(d.titleRows).toHaveLength(2);
  });

  it('skips leading blank rows without counting them as titles', () => {
    const rows = [
      ['', '', ''],
      ['Day', 'Program', 'Ticket'],
      ['1', '150', 'M-1'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBe(2);
    expect(d.titleRows).toEqual([]);
  });

  it('does not mistake a wide row of NUMBERS for the header', () => {
    // A sheet whose first row is data. Picking it would make the "column names"
    // a row of figures and poison every downstream comparison.
    const rows = [
      ['1', '150', '25', '2026-07-01'],
      ['Day', 'Program', 'Non-program', 'Date'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headers).toContain('Program');
    expect(d.headerRowIndex).toBe(2);
  });

  it('rejects a long prose cell as a column name', () => {
    const rows = [
      ['A'.repeat(120), 'B'.repeat(120), 'C'.repeat(120)],
      ['Item', 'Qty', 'Cost'],
      ['Widget', '2', '9.99'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBe(2);
  });

  it('reports WEAK rather than pretending, when nothing looks like a header', () => {
    // All-numeric sheet: there is no header. Saying so is the point — a confident
    // wrong answer is what the old code produced.
    const rows = [
      ['1', '2', '3'],
      ['4', '5', '6'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.confidence).toBe('weak');
    expect(d.headerRowIndex).toBeGreaterThan(0);
  });

  it('reports NONE for an empty sheet instead of inventing a row', () => {
    expect(detectHeaderRow([]).confidence).toBe('none');
    expect(detectHeaderRow([['', '']]).confidence).toBe('none');
    expect(detectHeaderRow([]).headerRowIndex).toBe(0);
  });

  it('does not scan indefinitely for a header', () => {
    // 30 title-ish rows then a header — beyond the window, so it must NOT be
    // found. A header on row 31 is not a header.
    const rows = [
      ...Array.from({ length: 30 }, () => ['Some title', '', '', '']),
      ['Day', 'Program', 'Non-program', 'Ticket'],
    ];
    const d = detectHeaderRow(rows);
    expect(d.headerRowIndex).toBeLessThanOrEqual(12);
  });
});
