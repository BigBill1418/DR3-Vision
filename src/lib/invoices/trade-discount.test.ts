// 2026-07-09 rollup §1.3 — the explicit GP Trade discount, pure parts.
//
// Mary's GP EOM invoice is three lines: gross month total, the "Trade discount"
// field (the mid-month bill already invoiced), balance due at the bottom. These
// tests pin (a) the composition carrying the discount + its mid-month reference
// as data, (b) the GP-terminology labels the summary renders, so her GP entry
// maps one-to-one and she never does the subtraction by hand (her §1.2 error
// class).

import { describe, expect, it } from 'vitest';
import { composeProcessing, type ProcessingGenerationInput } from './generate';
import { buildInvoiceSummaryModel } from './render-xlsx';
import type { InvoiceView, InvoiceLineView } from './view';
import { LINE_CODE } from './types';

const RATE_CA = 1650; // ¢ per unit

function caEomInput(over: Partial<ProcessingGenerationInput> = {}): ProcessingGenerationInput {
  return {
    kind: 'ca_processing_eom',
    processingRateCents: RATE_CA,
    processingRateRef: { rule: 'ca-2026' },
    strippedProgramUnits: 3208,
    strippedSource: { window: 'month' },
    incentiveCentsTotal: 0,
    incentiveUnits: 0,
    incentiveSource: null,
    events: [],
    eventsPending: false,
    midMonthOffsetCents: 1614000,
    midMonthOffsetUnits: 978.2,
    midMonthOffsetSource: { basis: 'mid_month_invoice', invoice_id: 'mid-1', version: 2 },
    midMonthReferenceInvoiceId: 'mid-1',
    ...over,
  };
}

describe('composeProcessing — Trade discount as data (rollup §1.3)', () => {
  it('CA EOM carries tradeDiscountCents + the mid-month reference', () => {
    const c = composeProcessing(caEomInput());
    expect(c.tradeDiscountCents).toBe(1614000);
    expect(c.tradeDiscountReferenceInvoiceId).toBe('mid-1');
    // The stored line is still the honest NEGATIVE offset; totals unchanged.
    const offset = c.lines.find((l) => l.lineCode === LINE_CODE.eomOffset);
    expect(offset?.amountCents).toBe(-1614000);
    expect(c.totalCents).toBe(Math.round(3208 * RATE_CA) - 1614000);
  });

  it('the offset line speaks GP: description says "Trade discount"', () => {
    const c = composeProcessing(caEomInput());
    const offset = c.lines.find((l) => l.lineCode === LINE_CODE.eomOffset);
    expect(offset?.description).toContain('Trade discount');
  });

  it('recomputed offset (no mid-month invoice on file) has a null reference', () => {
    const c = composeProcessing(caEomInput({ midMonthReferenceInvoiceId: null }));
    expect(c.tradeDiscountCents).toBe(1614000);
    expect(c.tradeDiscountReferenceInvoiceId).toBeNull();
  });

  it('mid-month + OR EOM compositions carry NO trade discount', () => {
    const mid = composeProcessing(
      caEomInput({ kind: 'ca_processing_mid_month', strippedProgramUnits: 978.2 }),
    );
    expect(mid.tradeDiscountCents).toBeUndefined();
    const orEom = composeProcessing(
      caEomInput({ kind: 'or_processing_eom', processingRateCents: 1700 }),
    );
    expect(orEom.tradeDiscountCents).toBeUndefined();
  });
});

// ── summary model: the three GP lines ───────────────────────────────────────

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

function caEomView(): InvoiceView {
  return {
    id: 'inv-1',
    siteId: 'site-woodland',
    kind: 'ca_processing_eom',
    billingMonth: new Date('2026-07-01T00:00:00Z'),
    windowStart: new Date('2026-07-01T00:00:00Z'),
    windowEnd: new Date('2026-07-31T00:00:00Z'),
    version: 1,
    supersedesId: null,
    status: 'draft',
    totalCents: 3208 * RATE_CA - 1614000,
    generatedBy: 'u1',
    generatedAt: new Date('2026-08-01T15:00:00Z'),
    approvedBy: null,
    approvedAt: null,
    voidedBy: null,
    voidedAt: null,
    gateOverrideNote: null,
    tradeDiscountCents: 1614000,
    tradeDiscountReferenceInvoiceId: 'mid-1',
    notes: null,
    lines: [
      line({
        lineCode: 'B6',
        description: 'Processing',
        quantity: '3208',
        amountCents: 3208 * RATE_CA,
        position: 0,
      }),
      line({
        lineCode: 'B22.offset',
        description: 'Trade discount — mid-month processing already invoiced',
        quantity: '978.2',
        amountCents: -1614000,
        position: 1,
      }),
    ],
  };
}

describe('buildInvoiceSummaryModel — GP framing on CA EOM (rollup §1.3)', () => {
  it('reads gross → Trade discount → balance due', () => {
    const m = buildInvoiceSummaryModel(caEomView());
    const b15 = m.rows.find((r) => r.code === 'B15');
    expect(b15?.label).toContain('Gross month total');
    expect(b15?.amountCents).toBe(3208 * RATE_CA);
    const total = m.rows.find((r) => r.code === 'TOTAL');
    expect(total?.label).toContain('Balance due');
    expect(total?.amountCents).toBe(3208 * RATE_CA - 1614000);
  });

  it('non-CA-EOM kinds keep the plain "Invoice total" label', () => {
    const v = {
      ...caEomView(),
      kind: 'or_processing_eom' as const,
      tradeDiscountCents: null,
      tradeDiscountReferenceInvoiceId: null,
    };
    const m = buildInvoiceSummaryModel(v);
    expect(m.rows.find((r) => r.code === 'TOTAL')?.label).toBe('Invoice total');
  });
});
