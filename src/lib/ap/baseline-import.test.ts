// ADR-0046 Amendment 5 (D-M5-4) — Bill-uploaded AP-report import: the pure local
// tabular parse (date + amount + vendor per line), the Claude JSON-array parse,
// and the confirm path (writes bill_upload history + rebuilds baselines).

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeDb } from './__testutils__/fake-prisma';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  parseBaselineText,
  parseImportDate,
  parseStructuredRows,
  confirmBaselineImport,
} from './baseline-import';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

describe('parseImportDate', () => {
  it('parses ISO and US M/D/Y (2-digit year → 20xx)', () => {
    expect(parseImportDate('2026-03-15')).toBe('2026-03-15');
    expect(parseImportDate('3/15/2026')).toBe('2026-03-15');
    expect(parseImportDate('3/5/26')).toBe('2026-03-05');
  });
  it('rejects impossible months/days', () => {
    expect(parseImportDate('2026-13-01')).toBeNull();
    expect(parseImportDate('13/40/2026')).toBeNull();
  });
});

describe('parseBaselineText', () => {
  it('extracts vendor + date + last amount per line and maps the site token', () => {
    const text = [
      'Clark Pest Control    03/15/2026    Woodland    $125.00',
      'Sunbelt Rentals   2026-04-02   Eugene   1,250.00',
    ].join('\n');
    const { rows } = parseBaselineText(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      vendorName: 'Clark Pest Control',
      invoiceDate: '2026-03-15',
      invoiceAmountCents: 12500,
      siteCode: 'woodland',
    });
    expect(rows[1]).toEqual({
      vendorName: 'Sunbelt Rentals',
      invoiceDate: '2026-04-02',
      invoiceAmountCents: 125000,
      siteCode: 'eugene',
    });
  });

  it('takes the LAST amount as the invoice total (line may list subtotal + total)', () => {
    const { rows } = parseBaselineText('Acme Co  2026-01-05  100.00  15.00  115.00');
    expect(rows[0]!.invoiceAmountCents).toBe(11500);
    expect(rows[0]!.vendorName).toBe('Acme Co');
  });

  it('surfaces a content line missing a date/amount as unparsed, never a row', () => {
    const { rows, unparsedLines } = parseBaselineText('Vendor With No Numbers Here\n=====');
    expect(rows).toHaveLength(0);
    expect(unparsedLines).toEqual(['Vendor With No Numbers Here']); // the ==== rule is skipped
  });
});

describe('parseStructuredRows (Claude JSON array)', () => {
  it('coerces valid objects and drops invalid ones, tolerating surrounding prose', () => {
    const out = parseStructuredRows(
      'Here you go: [' +
        '{"vendor_name":"Clark Pest","invoice_date":"2026-03-15","invoice_amount_cents":12500,"site":"woodland"},' +
        '{"vendor_name":"","invoice_date":"2026-03-15","invoice_amount_cents":100,"site":null},' +
        '{"vendor_name":"Acme","invoice_date":"bad","invoice_amount_cents":100,"site":null}' +
        '] done',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      vendorName: 'Clark Pest',
      invoiceDate: '2026-03-15',
      invoiceAmountCents: 12500,
      siteCode: 'woodland',
    });
  });

  it('returns [] on non-array / unparseable', () => {
    expect(parseStructuredRows('not json')).toEqual([]);
    expect(parseStructuredRows('{"vendor_name":"x"}')).toEqual([]);
  });
});

describe('confirmBaselineImport', () => {
  it('writes bill_upload history rows and rebuilds baselines', async () => {
    const db = newFakeDb({ sites: [{ id: 'site-woodland', code: 'woodland', name: 'DR3 Woodland' }] });
    const res = await confirmBaselineImport({
      prisma: fp(db),
      importedByUserId: 'u-admin',
      siteIdByCode: (code) => (code === 'woodland' ? 'site-woodland' : null),
      rows: [
        { vendorName: 'Clark Pest', invoiceDate: '2026-01-10', invoiceAmountCents: 19000, siteCode: 'woodland' },
        { vendorName: 'Clark Pest', invoiceDate: '2026-04-10', invoiceAmountCents: 20000, siteCode: 'woodland' },
        { vendorName: 'Clark Pest', invoiceDate: '2026-07-10', invoiceAmountCents: 21000, siteCode: 'woodland' },
      ],
    });
    expect(res.historyRowsWritten).toBe(3);
    expect(res.vendorsComputed).toBe(1);
    expect(db.baselineHistory.every((h) => h.source === 'bill_upload')).toBe(true);
    expect(db.baselineHistory[0]!.site_id).toBe('site-woodland');
    expect(db.baselines[0]!.mean_amount_cents).toBe(20000);
  });

  it('drops rows with a blank vendor before writing', async () => {
    const db = newFakeDb();
    const res = await confirmBaselineImport({
      prisma: fp(db),
      importedByUserId: 'u-admin',
      siteIdByCode: () => null,
      rows: [
        { vendorName: '   ', invoiceDate: '2026-01-10', invoiceAmountCents: 19000, siteCode: null },
        { vendorName: 'Acme', invoiceDate: '2026-01-11', invoiceAmountCents: 5000, siteCode: null },
      ],
    });
    expect(res.historyRowsWritten).toBe(1);
    expect(db.baselineHistory).toHaveLength(1);
  });
});
