// ADR-0041 amendment (rollup §6) — the invoice-combination validator.
//
// §6 closes the cadence: "Vision generator branches on (site, period,
// invoice_type); rejects invalid combos (Eugene mid-month, mid-month with Trade
// Discount, etc.)." Two combinations are structurally forbidden and must fail
// LOUD at generation rather than produce a wrong invoice:
//
//   1. EUGENE (OR) MID-MONTH — Oregon bills end-of-month ONLY (BillingCadence
//      `end_of_month_only`; there is no `or_processing_mid_month` kind). A
//      mid-month kind requested against an OR site is rejected. (The generic
//      kind↔site jurisdiction check catches this too, but §6 wants the specific,
//      named rejection so the operator sees WHY, not just "kind/site mismatch".)
//
//   2. MID-MONTH WITH A TRADE DISCOUNT — the Trade discount is the EOM invoice's
//      subtraction of an already-billed mid-month amount (the B22 offset). A
//      mid-month invoice that itself carries a Trade discount is nonsensical:
//      there is nothing yet to subtract. Rejected regardless of jurisdiction.
//
// Pure — the caller (service.ts) supplies the composed facts; this module owns no
// I/O so the rejection rules are exhaustively unit-testable.

import type { InvoiceComposition, InvoiceKind, Jurisdiction } from './types';
import { LINE_CODE } from './types';

/** The mid-month kinds (only CA has one; OR is EOM-only by construction). */
const MID_MONTH_KINDS: readonly InvoiceKind[] = ['ca_processing_mid_month'];

export function isMidMonthKind(kind: InvoiceKind): boolean {
  return MID_MONTH_KINDS.includes(kind);
}

/** A generation was asked for a structurally invalid (kind, site, discount) combo. */
export class InvoiceCombinationError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly reason: 'eugene_mid_month' | 'mid_month_with_trade_discount',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceCombinationError';
  }
}

/**
 * True when a composition carries a Trade discount — either the denormalized
 * `tradeDiscountCents` field is a positive amount, OR a nonzero B22 offset line
 * is present. (Belt-and-suspenders: either signal alone forbids a mid-month.)
 */
export function compositionHasTradeDiscount(composition: InvoiceComposition): boolean {
  if ((composition.tradeDiscountCents ?? 0) > 0) return true;
  return composition.lines.some(
    (l) => l.lineCode === LINE_CODE.eomOffset && l.amountCents !== 0,
  );
}

/**
 * Reject the two structurally invalid invoice combinations (§6). Throws
 * {@link InvoiceCombinationError}; returns void when the combination is allowed.
 */
export function assertValidInvoiceCombination(args: {
  kind: InvoiceKind;
  siteJurisdiction: Jurisdiction;
  hasTradeDiscount: boolean;
}): void {
  const { kind, siteJurisdiction, hasTradeDiscount } = args;

  if (isMidMonthKind(kind) && siteJurisdiction === 'OR') {
    throw new InvoiceCombinationError(
      'eugene_mid_month',
      `Eugene (OR) bills end-of-month only — a mid-month invoice (${kind}) cannot be ` +
        `generated for an OR site (rollup §6)`,
    );
  }

  if (isMidMonthKind(kind) && hasTradeDiscount) {
    throw new InvoiceCombinationError(
      'mid_month_with_trade_discount',
      `a mid-month invoice (${kind}) cannot carry a Trade discount — the Trade discount ` +
        `only ever subtracts an already-billed mid-month amount on the EOM invoice (rollup §6)`,
    );
  }
}
