// O-2 — classifyFileDrop is a pure advisory hint. These tests pin the exact
// mapping documented in docs/operator/file-drop.md so a future edit can't
// silently drift the hint the router relies on.

import { describe, it, expect } from 'vitest';
import { classifyFileDrop, type DetectedKind } from './classify';

const K = (filename: string, contentType: string | null): DetectedKind =>
  classifyFileDrop({ filename, contentType });

describe('classifyFileDrop', () => {
  it('maps workbook extensions to "workbook" regardless of content-type', () => {
    expect(K('MARCH 2026 DAILY LOG.xlsm', 'application/octet-stream')).toBe('workbook');
    expect(K('rates.xlsx', '')).toBe('workbook');
    expect(K('RATES.XLSX', null)).toBe('workbook'); // case-insensitive
  });

  it('maps .pdf to "pdf_document"', () => {
    expect(K('invoice.pdf', 'application/pdf')).toBe('pdf_document');
    expect(K('scan.PDF', null)).toBe('pdf_document');
  });

  it('maps .csv to "csv"', () => {
    expect(K('export.csv', 'text/csv')).toBe('csv');
    expect(K('export.CSV', 'application/vnd.ms-excel')).toBe('csv');
  });

  it('maps an image content-type to "image" when no matched extension', () => {
    expect(K('photo', 'image/jpeg')).toBe('image');
    expect(K('screenshot.png', 'image/png')).toBe('image');
    expect(K('x.heic', 'image/heic')).toBe('image');
  });

  it('extension precedence: a .csv wins over an image content-type', () => {
    // A file named data.csv with a mis-detected image content-type is still a csv.
    expect(K('data.csv', 'image/png')).toBe('csv');
  });

  it('falls through to "other" for anything unrecognized', () => {
    expect(K('notes.txt', 'text/plain')).toBe('other');
    expect(K('archive.zip', 'application/zip')).toBe('other');
    expect(K('no-extension', null)).toBe('other');
    expect(K('', null)).toBe('other');
    expect(K('.hidden', null)).toBe('other'); // leading dot is not an extension
    expect(K('trailingdot.', null)).toBe('other');
  });
});
