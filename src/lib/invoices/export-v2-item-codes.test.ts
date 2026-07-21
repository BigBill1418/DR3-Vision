// ADR-0041 amendment (rollup §9/§10) — item codes + MILES 0 aggregation + FUEL +
// attachments on the v2 GP export, reconciled against the REAL June-2026 invoice
// PDFs (§10). These numbers are production truth; the export must reproduce them.

import { describe, expect, it } from 'vitest';
import { invoiceExportV2, type GpExportContext } from './export-json';
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

function invoice(over: Partial<InvoiceView> & { kind: InvoiceKind }): InvoiceView {
  return {
    id: 'inv-1',
    siteId: 'site',
    billingMonth: new Date('2026-06-01T00:00:00Z'),
    windowStart: new Date('2026-06-01T00:00:00Z'),
    windowEnd: new Date('2026-06-30T00:00:00Z'),
    version: 1,
    supersedesId: null,
    status: 'approved',
    mode: 'pilot',
    totalCents: 0,
    programUnitsProcessed: null,
    nonProgramUnitsProcessed: null,
    generatedBy: 'u1',
    generatedAt: new Date('2026-07-01T15:00:00Z'),
    approvedBy: 'u2',
    approvedAt: new Date('2026-07-01T16:00:00Z'),
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

function ctx(siteName: string): GpExportContext {
  return {
    siteName,
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
      poNumber: '6/30/26 DR3 W',
      paymentTerms: 'Net 30',
      pendingNote: null,
    },
  };
}

describe('Woodland Processing EOM IVC072778 (§10) — LOCATION/UNITSMO/REIMBO/EVENTO', () => {
  // 17,126 × $16.50 = $282,579 ; REIMBO $15 ; EVENTO $4,235.35 ; TradeDiscount $138,699
  const b6 = 28257900;
  const b7 = 1500;
  const b8 = 423535;
  const discount = 13869900;
  const inv = invoice({
    kind: 'ca_processing_eom',
    totalCents: b6 + b7 + b8 - discount,
    programUnitsProcessed: 17126,
    nonProgramUnitsProcessed: 0,
    tradeDiscountCents: discount,
    tradeDiscountReferenceInvoiceId: 'mid-june',
    lines: [
      line({
        lineCode: 'B6',
        quantity: '17126',
        rateRef: { rate_cents: 1650 },
        amountCents: b6,
        position: 0,
      }),
      line({
        lineCode: 'B7',
        description: 'MRC- $3.00 Incentive Program',
        amountCents: b7,
        position: 1,
      }),
      line({ lineCode: 'B8', description: 'MRC- Event Labor', amountCents: b8, position: 2 }),
      line({
        lineCode: 'B22.offset',
        description: 'Trade discount',
        amountCents: -discount,
        position: 3,
      }),
    ],
  });

  it('emits the 6-line item-coded structure and reconciles to $148,130.35', () => {
    const out = invoiceExportV2(inv, ctx('Woodland'));
    const items = out.gp.lines.map((l) => l.item);
    expect(items).toEqual(['LOCATION', 'UNITSMO', 'LOCATION', 'REIMBO', 'LOCATION', 'EVENTO']);
    expect(out.gp.totals.subtotal_cents).toBe(b6 + b7 + b8); // 286,829.35
    expect(out.gp.totals.trade_discount_cents).toBe(discount); // 138,699.00
    expect(out.gp.totals.total_cents).toBe(14813035); // $148,130.35 ✓
    expect(out.gp.totals.total_cents).toBe(inv.totalCents);
  });

  it('EOM processing carries the commodity-breakdown attachment', () => {
    const out = invoiceExportV2(inv, ctx('Woodland'));
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]!.kind).toBe('commodity_breakdown');
  });
});

describe('Woodland Transportation EOM IVC072775 (§10) — MILES 0 + FUEL', () => {
  // MILES 0 = freight $55,650 + event-trans $925 + rental $10,800 = $67,375 ; FUEL $5,105.51
  const inv = invoice({
    kind: 'ca_transportation_eom',
    totalCents: 6737500 + 510551,
    lines: [
      line({ lineCode: 'B16.freight', description: 'Freight', amountCents: 5565000, position: 0 }),
      line({
        lineCode: 'B16.event_freight',
        description: 'Event freight',
        amountCents: 92500,
        position: 1,
      }),
      line({
        lineCode: 'B16.fuel',
        description: 'surcharge - June',
        amountCents: 510551,
        position: 2,
      }),
      line({ lineCode: 'B16.rentals', description: 'Rentals', amountCents: 1080000, position: 3 }),
    ],
  });

  it('aggregates freight+event-trans+rental into ONE MILES 0 line; fuel is its own FUEL line', () => {
    const out = invoiceExportV2(inv, ctx('Woodland'));
    expect(out.gp.lines.map((l) => l.item)).toEqual(['MILES 0', 'FUEL']);
    const miles0 = out.gp.lines[0]!;
    expect(miles0.extended_cents).toBe(6737500); // $67,375.00
    expect(out.gp.lines[1]!.extended_cents).toBe(510551); // $5,105.51
    expect(out.gp.totals.total_cents).toBe(7248051); // $72,480.51 ✓
    expect(out.gp.totals.total_cents).toBe(inv.totalCents);
  });

  it('transportation invoices carry NO commodity attachment', () => {
    const out = invoiceExportV2(inv, ctx('Woodland'));
    expect(out.attachments).toEqual([]);
  });
});

describe('Eugene Transportation EOM IVC072776 (§10) — MILES 0, NO fuel', () => {
  // MILES 0 = freight $12,900 + rental $900 + event-trans $0 = $13,800 ; NO FUEL
  const inv = invoice({
    kind: 'or_transportation_eom',
    totalCents: 1380000,
    lines: [
      line({ lineCode: 'B16.freight', description: 'Freight', amountCents: 1290000, position: 0 }),
      line({ lineCode: 'B16.rentals', description: 'Rentals', amountCents: 90000, position: 1 }),
    ],
  });

  it('one MILES 0 line, no FUEL line, reconciles to $13,800', () => {
    const out = invoiceExportV2(inv, ctx('Eugene'));
    expect(out.gp.lines.map((l) => l.item)).toEqual(['MILES 0']);
    expect(out.gp.lines[0]!.extended_cents).toBe(1380000);
    expect(out.gp.totals.total_cents).toBe(1380000);
  });
});

describe('Eugene Collections EOM IVC072779 (§10) — OREGON MATTRESS per site', () => {
  // 5 sites × $2.25/mattress = $1,714.50
  const inv = invoice({
    kind: 'or_collection_site_count',
    totalCents: 171450,
    lines: [
      line({
        lineCode: 'satellite',
        description: 'Cottage Grove',
        quantity: '67',
        rateRef: { rate_cents: 225 },
        amountCents: 15075,
        position: 0,
      }),
      line({
        lineCode: 'satellite',
        description: 'Salem',
        quantity: '203',
        rateRef: { rate_cents: 225 },
        amountCents: 45675,
        position: 1,
      }),
      line({
        lineCode: 'satellite',
        description: 'Albany',
        quantity: '379',
        rateRef: { rate_cents: 225 },
        amountCents: 85275,
        position: 2,
      }),
      line({
        lineCode: 'satellite',
        description: 'Florence',
        quantity: '59',
        rateRef: { rate_cents: 225 },
        amountCents: 13275,
        position: 3,
      }),
      line({
        lineCode: 'satellite',
        description: 'The Dalles',
        quantity: '54',
        rateRef: { rate_cents: 225 },
        amountCents: 12150,
        position: 4,
      }),
    ],
  });

  it('every line is OREGON MATTRESS; total reconciles to $1,714.50', () => {
    const out = invoiceExportV2(inv, ctx('Eugene'));
    expect(out.gp.lines).toHaveLength(5);
    expect(out.gp.lines.every((l) => l.item === 'OREGON MATTRESS')).toBe(true);
    expect(out.gp.lines[0]!.unit_price_cents).toBe(225);
    expect(out.gp.totals.total_cents).toBe(171450);
  });

  it('a manual adjustment line is carried but NOT stamped OREGON MATTRESS (item = null)', () => {
    // Rollup §9 locks OREGON MATTRESS to "collection-site per-mattress ($2.25)"; a
    // manual credit/fee must not borrow that code (mislabels the charge to Mary/GP).
    const withManual = invoice({
      kind: 'or_collection_site_count',
      totalCents: 171450 - 5000, // one $50.00 credit
      lines: [
        line({
          lineCode: 'satellite',
          description: 'Cottage Grove',
          quantity: '67',
          rateRef: { rate_cents: 225 },
          amountCents: 15075,
          position: 0,
        }),
        line({
          lineCode: 'satellite',
          description: 'Salem',
          quantity: '203',
          rateRef: { rate_cents: 225 },
          amountCents: 45675,
          position: 1,
        }),
        line({
          lineCode: 'satellite',
          description: 'Albany',
          quantity: '379',
          rateRef: { rate_cents: 225 },
          amountCents: 85275,
          position: 2,
        }),
        line({
          lineCode: 'satellite',
          description: 'Florence',
          quantity: '59',
          rateRef: { rate_cents: 225 },
          amountCents: 13275,
          position: 3,
        }),
        line({
          lineCode: 'satellite',
          description: 'The Dalles',
          quantity: '54',
          rateRef: { rate_cents: 225 },
          amountCents: 12150,
          position: 4,
        }),
        line({
          lineCode: 'manual',
          description: 'Goodwill credit',
          quantity: null,
          rateRef: null,
          amountCents: -5000,
          position: 5,
        }),
      ],
    });
    const out = invoiceExportV2(withManual, ctx('Eugene'));
    expect(out.gp.lines).toHaveLength(6);
    const manual = out.gp.lines.find((l) => l.description === 'Goodwill credit')!;
    expect(manual.item).toBeNull();
    // The five real collection lines still carry the per-mattress code.
    expect(out.gp.lines.filter((l) => l.item === 'OREGON MATTRESS')).toHaveLength(5);
    // The invariant still holds — the manual line's amount is in the reconciled total.
    expect(out.gp.totals.total_cents).toBe(166450);
  });
});
