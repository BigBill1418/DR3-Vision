// ADR-0067 §3.2 D5/D7/D8 — structural parsing.
//
// The .xlsm case is MANDATORY (the daily logs are macro-enabled workbooks), so
// it is exercised against REAL OOXML bytes built with exceljs rather than a
// stub: a mocked reader would prove only that the code calls a function.

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { looksPasswordProtected, parseDocument, summaryFromJson } from '../parse';

/**
 * Real Office Open XML bytes. exceljs writes the same OOXML package for `.xlsx`
 * and `.xlsm` — the difference is the presence of a `vbaProject.bin` part, which
 * exceljs neither writes nor reads. That is exactly the property under test: the
 * parser has no macro engine, so naming these bytes `.xlsm` drives the real
 * macro-workbook code path with no VBA execution possible.
 */
async function workbookBytes(
  sheets: { name: string; rows: (string | number | null)[][] }[],
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

describe('parseDocument — .xlsm workbooks (D8, mandatory)', () => {
  it('parses a macro-enabled workbook WITHOUT executing macros', async () => {
    const bytes = await workbookBytes([
      {
        name: 'Daily Log',
        rows: [
          ['Date', 'Units', 'Amount'],
          ['2026-07-01', 12, 240.5],
          ['2026-07-02', 8, 160.25],
        ],
      },
    ]);

    const result = await parseDocument(bytes, 'JULY 2026 DAILY LOG.xlsm', null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.format).toBe('xlsx');
    expect(result.summary.totalRows).toBe(2);
    const sheet = result.summary.sheets[0];
    expect(sheet?.name).toBe('Daily Log');
    expect(sheet?.headers).toEqual(['Date', 'Units', 'Amount']);
    expect(sheet?.numericTotals['Units']).toBe(20);
    expect(sheet?.numericTotals['Amount']).toBeCloseTo(400.75, 2);
  });

  it('tracks populated columns so an emptied column is detectable later', async () => {
    const bytes = await workbookBytes([
      {
        name: 'Sheet1',
        rows: [
          ['A', 'B', 'C'],
          ['x', null, 'z'],
        ],
      },
    ]);
    const result = await parseDocument(bytes, 'x.xlsm', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.sheets[0]?.populatedColumns).toEqual(['A', 'C']);
  });

  it('sums across multiple sheets into one row total', async () => {
    const bytes = await workbookBytes([
      { name: 'Eugene', rows: [['Units'], [10], [20]] },
      { name: 'Woodland', rows: [['Units'], [5]] },
    ]);
    const result = await parseDocument(bytes, 'x.xlsm', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.totalRows).toBe(3);
    expect(result.summary.sheets).toHaveLength(2);
  });
});

describe('parseDocument — password-protected (D8)', () => {
  // An encrypted OOXML file is an OLE/CFB compound file, not a zip. Sniffing the
  // magic bytes gives a PRECISE answer, which is what lets the caller latch the
  // source instead of retrying a password prompt forever.
  const OLE_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);

  it('detects an encrypted workbook from its container magic', () => {
    expect(looksPasswordProtected(OLE_HEADER, 'Protected.xlsm')).toBe(true);
    expect(looksPasswordProtected(OLE_HEADER, 'Protected.xlsx')).toBe(true);
  });

  it('returns the password_protected reason rather than a generic failure', async () => {
    const result = await parseDocument(OLE_HEADER, 'Protected.xlsm', null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('password_protected');
    expect(result.message).toContain('will not keep trying');
  });

  it('does NOT mistake an ordinary workbook for an encrypted one', async () => {
    const bytes = await workbookBytes([{ name: 'S', rows: [['A'], [1]] }]);
    expect(looksPasswordProtected(bytes, 'fine.xlsm')).toBe(false);
  });

  it('distinguishes CORRUPT from encrypted — they need different operator action', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = await parseDocument(garbage, 'broken.xlsm', null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('corrupt');
  });
});

describe('parseDocument — other formats', () => {
  it('summarizes CSV with the same shape a workbook produces', async () => {
    const csv = 'Vendor,Amount\nAcme,100.50\nBeta,200.25\n';
    const result = await parseDocument(new TextEncoder().encode(csv), 'history.csv', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.format).toBe('csv');
    expect(result.summary.totalRows).toBe(2);
    expect(result.summary.sheets[0]?.numericTotals['Amount']).toBeCloseTo(300.75, 2);
  });

  it('reports an unknown format as `unsupported`, not as an error', async () => {
    const result = await parseDocument(new Uint8Array([1, 2, 3]), 'thing.dwg', null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "No reader" is a fact about us, not a fault in the document — and the
    // distinction decides whether the source gets latched.
    expect(result.reason).toBe('unsupported');
  });

  it('treats an empty file as corrupt', async () => {
    const result = await parseDocument(new Uint8Array(), 'empty.xlsm', null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('corrupt');
  });
});

describe('summaryFromJson', () => {
  it('round-trips a real summary', async () => {
    const bytes = await workbookBytes([{ name: 'S', rows: [['Units'], [3]] }]);
    const result = await parseDocument(bytes, 'x.xlsm', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const round = summaryFromJson(JSON.parse(JSON.stringify(result.summary)));
    expect(round?.totalRows).toBe(1);
  });

  it('returns null for an unrecognizable shape so the guardrail treats it as "no baseline"', () => {
    // Comparing against garbage would stage a change for no reason.
    expect(summaryFromJson(null)).toBeNull();
    expect(summaryFromJson({ nonsense: true })).toBeNull();
    expect(summaryFromJson('a string')).toBeNull();
  });
});
