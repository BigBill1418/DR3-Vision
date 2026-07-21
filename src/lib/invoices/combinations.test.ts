// ADR-0041 amendment (rollup §6) — the invoice-combination validator.

import { describe, expect, it } from 'vitest';
import {
  assertValidInvoiceCombination,
  compositionHasTradeDiscount,
  isMidMonthKind,
  InvoiceCombinationError,
} from './combinations';
import type { InvoiceComposition } from './types';

function comp(over: Partial<InvoiceComposition> = {}): InvoiceComposition {
  return { lines: [], totalCents: 0, ...over };
}

describe('isMidMonthKind', () => {
  it('only ca_processing_mid_month is mid-month', () => {
    expect(isMidMonthKind('ca_processing_mid_month')).toBe(true);
    expect(isMidMonthKind('ca_processing_eom')).toBe(false);
    expect(isMidMonthKind('or_processing_eom')).toBe(false);
    expect(isMidMonthKind('or_collection_site_count')).toBe(false);
  });
});

describe('compositionHasTradeDiscount', () => {
  it('true when tradeDiscountCents is a positive amount', () => {
    expect(compositionHasTradeDiscount(comp({ tradeDiscountCents: 138699_00 }))).toBe(true);
  });
  it('true when a nonzero B22.offset line is present', () => {
    expect(
      compositionHasTradeDiscount(
        comp({
          lines: [
            { lineCode: 'B22.offset', description: 'x', quantity: null, rateRef: null, amountCents: -100, source: null, position: 0 },
          ],
        }),
      ),
    ).toBe(true);
  });
  it('false for a plain composition (no discount)', () => {
    expect(compositionHasTradeDiscount(comp())).toBe(false);
    expect(compositionHasTradeDiscount(comp({ tradeDiscountCents: 0 }))).toBe(false);
  });
});

describe('assertValidInvoiceCombination — §6 rejections', () => {
  it('REJECTS a mid-month kind for an OR site (Eugene mid-month)', () => {
    try {
      assertValidInvoiceCombination({
        kind: 'ca_processing_mid_month',
        siteJurisdiction: 'OR',
        hasTradeDiscount: false,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvoiceCombinationError);
      expect((e as InvoiceCombinationError).reason).toBe('eugene_mid_month');
      expect((e as InvoiceCombinationError).status).toBe(422);
    }
  });

  it('REJECTS any mid-month invoice carrying a Trade discount', () => {
    try {
      assertValidInvoiceCombination({
        kind: 'ca_processing_mid_month',
        siteJurisdiction: 'CA',
        hasTradeDiscount: true,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvoiceCombinationError);
      expect((e as InvoiceCombinationError).reason).toBe('mid_month_with_trade_discount');
    }
  });

  it('ALLOWS a CA mid-month with no trade discount', () => {
    expect(() =>
      assertValidInvoiceCombination({
        kind: 'ca_processing_mid_month',
        siteJurisdiction: 'CA',
        hasTradeDiscount: false,
      }),
    ).not.toThrow();
  });

  it('ALLOWS a CA EOM carrying a trade discount (that is exactly where it belongs)', () => {
    expect(() =>
      assertValidInvoiceCombination({
        kind: 'ca_processing_eom',
        siteJurisdiction: 'CA',
        hasTradeDiscount: true,
      }),
    ).not.toThrow();
  });

  it('ALLOWS an OR EOM processing invoice', () => {
    expect(() =>
      assertValidInvoiceCombination({
        kind: 'or_processing_eom',
        siteJurisdiction: 'OR',
        hasTradeDiscount: false,
      }),
    ).not.toThrow();
  });
});
