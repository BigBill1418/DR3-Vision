// ADR-0046 Amendment 5 (D-M5-5) — invoice history search: the pure filter/merge
// core (vendor typeahead, date range, amount range, site, approver, source) and
// the newest-first sort.

import { describe, expect, it } from 'vitest';
import { filterHistory, type HistoryEntry } from './history';

const vision = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'v1',
  source: 'vision',
  vendorName: 'Clark Pest Control',
  vendorNameNormalized: 'clark pest control',
  amountCents: 20000,
  invoiceDate: '2026-06-15',
  siteCode: 'woodland',
  status: 'approved',
  approverId: 'u-bill',
  approverName: 'Bill',
  ...over,
});

const imported = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'i1',
  source: 'import',
  vendorName: 'Sunbelt Rentals',
  vendorNameNormalized: 'sunbelt rentals',
  amountCents: 5000,
  invoiceDate: '2025-11-01',
  siteCode: 'eugene',
  importedBy: 'u-bill',
  ...over,
});

describe('filterHistory', () => {
  it('returns everything, newest-first, with no filters', () => {
    const out = filterHistory([imported(), vision()], {});
    expect(out.map((e) => e.id)).toEqual(['v1', 'i1']); // 2026 before 2025
  });

  it('vendor typeahead matches the normalized substring across sources', () => {
    const out = filterHistory([vision(), imported()], { vendor: 'CLARK' });
    expect(out.map((e) => e.id)).toEqual(['v1']);
  });

  it('date range is inclusive on both ends', () => {
    const rows = [
      vision({ id: 'a', invoiceDate: '2026-01-01' }),
      vision({ id: 'b', invoiceDate: '2026-06-15' }),
      vision({ id: 'c', invoiceDate: '2026-12-31' }),
    ];
    const out = filterHistory(rows, { dateFrom: '2026-06-15', dateTo: '2026-12-31' });
    expect(out.map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('amount range excludes out-of-range AND null-amount rows', () => {
    const rows = [
      vision({ id: 'lo', amountCents: 1000 }),
      vision({ id: 'mid', amountCents: 20000 }),
      vision({ id: 'hi', amountCents: 90000 }),
      vision({ id: 'null', amountCents: null }),
    ];
    const out = filterHistory(rows, { amountMinCents: 5000, amountMaxCents: 50000 });
    expect(out.map((e) => e.id)).toEqual(['mid']);
  });

  it('site filter matches the code (incl. not_dr3)', () => {
    const rows = [
      vision({ id: 'w', siteCode: 'woodland' }),
      vision({ id: 'e', siteCode: 'eugene' }),
      vision({ id: 'n', siteCode: 'not_dr3' }),
    ];
    expect(filterHistory(rows, { siteCode: 'eugene' }).map((e) => e.id)).toEqual(['e']);
    expect(filterHistory(rows, { siteCode: 'not_dr3' }).map((e) => e.id)).toEqual(['n']);
  });

  it('approver filter matches Vision rows and excludes import rows (no approver)', () => {
    const out = filterHistory([vision({ approverId: 'u-bill' }), imported()], {
      approverId: 'u-bill',
    });
    expect(out.map((e) => e.id)).toEqual(['v1']);
  });

  it('source filter isolates a provenance', () => {
    expect(filterHistory([vision(), imported()], { source: 'import' }).map((e) => e.id)).toEqual([
      'i1',
    ]);
    expect(filterHistory([vision(), imported()], { source: 'vision' }).map((e) => e.id)).toEqual([
      'v1',
    ]);
  });

  it('AND-combines multiple filters', () => {
    const rows = [
      vision({ id: 'match', vendorNameNormalized: 'clark pest', amountCents: 20000, siteCode: 'woodland' }),
      vision({ id: 'wrongsite', vendorNameNormalized: 'clark pest', amountCents: 20000, siteCode: 'eugene' }),
      vision({ id: 'wrongvendor', vendorNameNormalized: 'acme', amountCents: 20000, siteCode: 'woodland' }),
    ];
    const out = filterHistory(rows, { vendor: 'clark', siteCode: 'woodland', amountMinCents: 10000 });
    expect(out.map((e) => e.id)).toEqual(['match']);
  });
});
