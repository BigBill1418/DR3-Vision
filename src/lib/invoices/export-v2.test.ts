// ADR-0041 amendment §4.2 — the v2 GP export (two-line processing structure,
// trade-discount subtraction, reconciliation, GP identifiers) + proof that v1
// stays frozen.

import { describe, expect, it } from 'vitest';
import { invoiceExportV1, invoiceExportV2, type GpExportContext } from './export-json';
import { InvoiceInvariantError } from './view';
import type { InvoiceView, InvoiceLineView } from './view';
import type { InvoiceKind } from './types';

const RATE_CA = 1650;

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

function invoice(over: Partial<InvoiceView> & { kind: InvoiceKind }): InvoiceView {
  return {
    id: 'inv-1',
    siteId: 'site-woodland',
    billingMonth: new Date('2026-07-01T00:00:00Z'),
    windowStart: new Date('2026-07-01T00:00:00Z'),
    windowEnd: new Date('2026-07-31T00:00:00Z'),
    version: 1,
    supersedesId: null,
    status: 'approved',
    mode: 'pilot',
    totalCents: 0,
    programUnitsProcessed: null,
    nonProgramUnitsProcessed: null,
    generatedBy: 'u1',
    generatedAt: new Date('2026-08-01T15:00:00Z'),
    approvedBy: 'u2',
    approvedAt: new Date('2026-08-01T16:00:00Z'),
    voidedBy: null,
    voidedAt: null,
    gateOverrideNote: null,
    tradeDiscountCents: null,
    tradeDiscountReferenceInvoiceId: null,
    notes: null,
    lines: [],
    ...over,
  };
}

const CTX: GpExportContext = {
  siteName: 'Woodland',
  gp: {
    billTo: {
      name: 'Mattress Recycling Council',
      attn: 'Ryan Trainer',
      street: '501 Wythe Street',
      locality: 'Alexandria VA 22314',
    },
    shipTo: {
      name: 'Mattress Recycling Council',
      attn: 'Ryan Trainer',
      street: '501 Wythe Street',
      locality: 'Alexandria VA 22314',
    },
    customerId: 'MRCL001',
    salesId: '34',
    poNumber: '7/31/26 DR3W',
    paymentTerms: 'Net 30',
    pendingNote: null,
  },
};

/** A clean CA processing invoice: one B6 line, no incentives/events. */
function cleanCaProcessing(units: number): InvoiceView {
  const charge = Math.round(units * RATE_CA);
  return invoice({
    kind: 'ca_processing_eom',
    totalCents: charge,
    programUnitsProcessed: units,
    nonProgramUnitsProcessed: 12,
    lines: [
      line({
        lineCode: 'B6',
        description: 'Processing',
        quantity: String(units),
        rateRef: { rule_kind: 'processing_rate', rate_cents: RATE_CA },
        amountCents: charge,
        position: 0,
      }),
    ],
  });
}

describe('invoiceExportV2 — §4.2 two-line processing structure', () => {
  it('renders the header line + the MRC-Processed Units UNITSMO line', () => {
    const inv = cleanCaProcessing(3977);
    const out = invoiceExportV2(inv, CTX);
    expect(out.version).toBe(2);
    expect(out.gp.presentation).toBe('processing');
    expect(out.gp.lines).toHaveLength(2);

    const header = out.gp.lines[0]!;
    const billable = out.gp.lines[1]!;
    expect(header.description).toBe('total units processed 7/31/26');
    expect(header.extended_cents).toBe(0);
    expect(header.unit_price_cents).toBe(0);

    expect(billable.description).toBe('MRC-Processed Units DR3 Woodland');
    expect(billable.unit_of_measure).toBe('UNITSMO');
    expect(billable.quantity).toBe('3977');
    expect(billable.unit_price_cents).toBe(RATE_CA);
    expect(billable.extended_cents).toBe(3977 * RATE_CA);
  });

  it('totals: Misc/Tax/Freight are $0 on a clean processing invoice, total reconciles', () => {
    const inv = cleanCaProcessing(3977);
    const out = invoiceExportV2(inv, CTX);
    expect(out.gp.totals.subtotal_cents).toBe(3977 * RATE_CA);
    expect(out.gp.totals.misc_cents).toBe(0);
    expect(out.gp.totals.tax_cents).toBe(0);
    expect(out.gp.totals.freight_cents).toBe(0);
    expect(out.gp.totals.trade_discount_cents).toBe(0);
    expect(out.gp.totals.total_cents).toBe(inv.totalCents);
  });

  it('carries the GP header identifiers (Bill-To, Customer ID, Sales ID, PO, Terms)', () => {
    const out = invoiceExportV2(cleanCaProcessing(100), CTX);
    expect(out.gp.header.bill_to.name).toBe('Mattress Recycling Council');
    expect(out.gp.header.ship_to.attn).toBe('Ryan Trainer');
    expect(out.gp.header.customer_id).toBe('MRCL001');
    expect(out.gp.header.sales_id).toBe('34');
    expect(out.gp.header.po_number).toBe('7/31/26 DR3W');
    expect(out.gp.header.payment_terms).toBe('Net 30');
  });

  it('carries mode + the program/non-program split as data', () => {
    const out = invoiceExportV2(cleanCaProcessing(3977), CTX);
    expect(out.invoice.mode).toBe('pilot');
    expect(out.invoice.program_units_processed).toBe('3977');
    expect(out.invoice.non_program_units_processed).toBe('12');
  });
});

describe('invoiceExportV2 — EOM subtracts the mid-month (Trade discount)', () => {
  it('Gross → Trade discount → balance; total = gross − mid-month', () => {
    const units = 3977;
    const gross = units * RATE_CA;
    const midMonth = 1614000; // the prior mid-month bill
    const inv = invoice({
      kind: 'ca_processing_eom',
      totalCents: gross - midMonth,
      programUnitsProcessed: units,
      nonProgramUnitsProcessed: 0,
      tradeDiscountCents: midMonth,
      tradeDiscountReferenceInvoiceId: 'mid-1',
      lines: [
        line({
          lineCode: 'B6',
          description: 'Processing',
          quantity: String(units),
          rateRef: { rule_kind: 'processing_rate', rate_cents: RATE_CA },
          amountCents: gross,
          position: 0,
        }),
        line({
          lineCode: 'B22.offset',
          description: 'Trade discount — mid-month processing already invoiced',
          quantity: '978.2',
          amountCents: -midMonth,
          position: 1,
        }),
      ],
    });
    const out = invoiceExportV2(inv, CTX);
    // Line 2 (subtotal) is the FULL month gross; the Trade discount subtracts the
    // mid-month; total is the balance due — exactly Mary's GP entry order.
    expect(out.gp.totals.subtotal_cents).toBe(gross);
    expect(out.gp.totals.trade_discount_cents).toBe(midMonth);
    expect(out.gp.totals.total_cents).toBe(gross - midMonth);
    expect(out.gp.totals.total_cents).toBe(inv.totalCents);
    expect(out.invoice.trade_discount_cents).toBe(midMonth);
    expect(out.invoice.trade_discount_reference_invoice_id).toBe('mid-1');
  });

  it('B7 incentives + B8 event misc surface as Misc (never dropped)', () => {
    const units = 100;
    const b6 = units * RATE_CA;
    const b7 = 6000;
    const b8 = 54000;
    const inv = invoice({
      kind: 'ca_processing_eom',
      totalCents: b6 + b7 + b8,
      programUnitsProcessed: units,
      nonProgramUnitsProcessed: 0,
      lines: [
        line({ lineCode: 'B6', quantity: String(units), rateRef: { rate_cents: RATE_CA }, amountCents: b6, position: 0 }),
        line({ lineCode: 'B7', amountCents: b7, position: 1 }),
        line({ lineCode: 'B8', amountCents: b8, position: 2 }),
      ],
    });
    const out = invoiceExportV2(inv, CTX);
    expect(out.gp.totals.subtotal_cents).toBe(b6);
    expect(out.gp.totals.misc_cents).toBe(b7 + b8);
    expect(out.gp.totals.total_cents).toBe(inv.totalCents);
  });
});

describe('invoiceExportV2 — mid-month, other kinds, reconciliation', () => {
  it('mid-month invoice: one B20 charge, no trade discount', () => {
    const units = 978.2;
    const charge = Math.round(units * RATE_CA);
    const inv = invoice({
      kind: 'ca_processing_mid_month',
      billingMonth: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-15T00:00:00Z'),
      totalCents: charge,
      programUnitsProcessed: units,
      nonProgramUnitsProcessed: 0,
      lines: [
        line({ lineCode: 'B20', quantity: String(units), rateRef: { rate_cents: RATE_CA }, amountCents: charge, position: 0 }),
      ],
    });
    const out = invoiceExportV2(inv, CTX);
    expect(out.gp.lines[1]!.extended_cents).toBe(charge);
    expect(out.gp.lines[1]!.quantity).toBe('978.2');
    expect(out.gp.lines[0]!.description).toBe('total units processed 7/15/26');
    expect(out.gp.totals.trade_discount_cents).toBe(0);
    expect(out.gp.totals.total_cents).toBe(inv.totalCents);
  });

  it('transportation: one gp_line per B16 leaf, reconciles', () => {
    const inv = invoice({
      kind: 'ca_transportation_eom',
      totalCents: 97000 + 150000,
      lines: [
        line({ lineCode: 'B16.freight', description: 'Freight', amountCents: 97000, position: 0 }),
        line({ lineCode: 'B16.rentals', description: 'Rentals', amountCents: 150000, position: 1 }),
      ],
    });
    const out = invoiceExportV2(inv, CTX);
    expect(out.gp.presentation).toBe('transportation');
    expect(out.gp.lines).toHaveLength(2);
    expect(out.gp.totals.total_cents).toBe(inv.totalCents);
  });

  it('OR/Eugene null identifiers pass through as null (never invented)', () => {
    const inv = cleanCaProcessing(100);
    const orCtx: GpExportContext = {
      siteName: 'Eugene',
      gp: { ...CTX.gp, customerId: null, poNumber: null, pendingNote: 'pending Mary' },
    };
    const out = invoiceExportV2(inv, orCtx);
    expect(out.gp.header.customer_id).toBeNull();
    expect(out.gp.header.po_number).toBeNull();
    expect(out.gp.header.pending_note).toBe('pending Mary');
  });

  it('reconciliation tripwire: a stored total disagreeing with the lines throws', () => {
    const inv = cleanCaProcessing(100);
    const doctored = { ...inv, totalCents: inv.totalCents + 1 }; // corrupt the total
    expect(() => invoiceExportV2(doctored, CTX)).toThrow(InvoiceInvariantError);
  });
});

describe('invoiceExportV1 stays FROZEN (no v2 fields leak in)', () => {
  it('v1 has no gp block, no mode, version === 1', () => {
    const out = invoiceExportV1(cleanCaProcessing(100)) as unknown as Record<string, unknown>;
    expect(out['version']).toBe(1);
    expect('gp' in out).toBe(false);
    expect('mode' in (out['invoice'] as Record<string, unknown>)).toBe(false);
    // v1 invoice key set is exactly the frozen contract.
    expect(Object.keys(out['invoice'] as object).sort()).toEqual(
      [
        'approved_at',
        'billing_month',
        'generated_at',
        'id',
        'kind',
        'site_id',
        'status',
        'supersedes_id',
        'total_cents',
        'version',
        'window',
      ].sort(),
    );
  });
});
