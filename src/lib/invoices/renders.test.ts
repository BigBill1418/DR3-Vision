import { describe, expect, it } from 'vitest';
import { buildInvoiceSummaryModel, renderInvoiceXlsxBuffer } from './render-xlsx';
import { invoiceExportV1 } from './export-json';
import type { InvoiceView, InvoiceLineView } from './view';
import type { InvoiceKind } from './types';

function line(over: Partial<InvoiceLineView>): InvoiceLineView {
  return {
    id: `l-${over.lineCode ?? 'x'}`,
    lineCode: 'B6',
    description: 'desc',
    quantity: null,
    rateRef: null,
    amountCents: 0,
    source: null,
    position: 0,
    ...over,
  };
}

function invoice(kind: InvoiceKind, lines: InvoiceLineView[], totalCents: number): InvoiceView {
  return {
    id: 'inv-1',
    siteId: 'site-woodland',
    kind,
    billingMonth: new Date('2026-06-01T00:00:00Z'),
    windowStart: new Date('2026-06-01T00:00:00Z'),
    windowEnd: new Date('2026-06-30T00:00:00Z'),
    version: 1,
    supersedesId: null,
    status: 'draft',
    totalCents,
    generatedBy: 'u1',
    generatedAt: new Date('2026-07-01T15:00:00Z'),
    approvedBy: null,
    approvedAt: null,
    voidedBy: null,
    voidedAt: null,
    gateOverrideNote: null,
    tradeDiscountCents: null,
    tradeDiscountReferenceInvoiceId: null,
    notes: null,
    lines,
  };
}

// CA EOM processing: B6 + B7 + B8 − B22.offset  (B15 subtotal derived)
const caEom = invoice(
  'ca_processing_eom',
  [
    line({
      lineCode: 'B6',
      description: 'Processing',
      quantity: '300',
      amountCents: 495000,
      position: 0,
    }),
    line({
      lineCode: 'B7',
      description: 'Incentives',
      quantity: '20',
      amountCents: 6000,
      position: 1,
    }),
    line({
      lineCode: 'B8',
      description: 'Event misc',
      quantity: '1',
      amountCents: 54000,
      position: 2,
    }),
    line({
      lineCode: 'B22.offset',
      description: 'Less: mid-month',
      quantity: '150',
      amountCents: -247500,
      position: 3,
    }),
  ],
  495000 + 6000 + 54000 - 247500,
);

describe('buildInvoiceSummaryModel — CA EOM processing parity (§3.1)', () => {
  it('inserts a derived B15 subtotal before the offset, ends with the total', () => {
    const m = buildInvoiceSummaryModel(caEom);
    const codes = m.rows.map((r) => r.code);
    expect(codes).toEqual(['B6', 'B7', 'B8', 'B15', 'B22.offset', 'TOTAL']);
    const b15 = m.rows.find((r) => r.code === 'B15');
    expect(b15?.amountCents).toBe(495000 + 6000 + 54000); // Σ leaves
    expect(b15?.kind).toBe('subtotal');
    const total = m.rows.find((r) => r.code === 'TOTAL');
    expect(total?.amountCents).toBe(495000 + 6000 + 54000 - 247500); // B22
  });
});

describe('buildInvoiceSummaryModel — transportation (no B15 subtotal)', () => {
  it('renders B16 leaves + total only', () => {
    const trans = invoice(
      'ca_transportation_eom',
      [
        line({ lineCode: 'B16.freight', description: 'Freight', amountCents: 97000, position: 0 }),
        line({ lineCode: 'B16.rentals', description: 'Rentals', amountCents: 150000, position: 1 }),
      ],
      247000,
    );
    const codes = buildInvoiceSummaryModel(trans).rows.map((r) => r.code);
    expect(codes).toEqual(['B16.freight', 'B16.rentals', 'TOTAL']);
  });
});

describe('invoiceExportV1 — frozen contract shape (GP boundary)', () => {
  it('serializes to the exact v1 key set', () => {
    const e = invoiceExportV1(caEom);
    expect(e.schema).toBe('dr3.invoice_export');
    expect(e.version).toBe(1);
    expect(Object.keys(e)).toEqual(['schema', 'version', 'invoice', 'lines']);
    expect(Object.keys(e.invoice)).toEqual([
      'id',
      'site_id',
      'kind',
      'billing_month',
      'window',
      'version',
      'supersedes_id',
      'status',
      'total_cents',
      'generated_at',
      'approved_at',
    ]);
    expect(e.invoice.billing_month).toBe('2026-06-01');
    expect(e.invoice.window).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(e.invoice.total_cents).toBe(495000 + 6000 + 54000 - 247500);
    expect(Object.keys(e.lines[0]!)).toEqual([
      'line_code',
      'description',
      'quantity',
      'amount_cents',
      'rate_ref',
      'source',
      'position',
    ]);
  });
});

describe('renderInvoiceXlsxBuffer — produces a real xlsx (zip) buffer', () => {
  it('returns a non-empty PK-signed buffer', async () => {
    const buf = await renderInvoiceXlsxBuffer(caEom);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK'); // zip magic
  });
});
