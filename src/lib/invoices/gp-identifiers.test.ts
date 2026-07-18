// ADR-0041 amendment §4.2 — GP identifier resolution (PO formatting + the
// "never invent an unknown" rule).

import { describe, expect, it } from 'vitest';
import { formatMDDYY, buildPoNumber, buildGpContext, type GpBillingStatics } from './gp-identifiers';

const STATICS: GpBillingStatics = {
  billTo: {
    name: 'Mattress Recycling Council',
    attn: 'Ryan Trainer',
    street: '501 Wythe Street',
    locality: 'Alexandria VA 22314',
  },
  salesId: '34',
  paymentTerms: 'Net 30',
};

describe('formatMDDYY', () => {
  it('un-pads month, 2-digits day + year (Pacific = UTC components)', () => {
    expect(formatMDDYY(new Date('2026-07-31T00:00:00Z'))).toBe('7/31/26');
    expect(formatMDDYY(new Date('2026-11-05T00:00:00Z'))).toBe('11/05/26');
    expect(formatMDDYY(new Date('2026-01-01T00:00:00Z'))).toBe('1/01/26');
  });
});

describe('buildPoNumber — never invents an unknown suffix', () => {
  it('CA/Woodland (DR3W) → "M/DD/YY DR3W"', () => {
    expect(buildPoNumber(new Date('2026-07-31T00:00:00Z'), 'DR3W')).toBe('7/31/26 DR3W');
  });

  it('null suffix (Eugene, pending Mary) → null PO, NOT a partial string', () => {
    expect(buildPoNumber(new Date('2026-07-31T00:00:00Z'), null)).toBeNull();
  });
});

describe('buildGpContext', () => {
  it('CA Woodland: all identifiers known', () => {
    const ctx = buildGpContext({
      statics: STATICS,
      site: { customerId: 'MRCL001', poSiteSuffix: 'DR3W', pendingNote: null },
      invoiceDate: new Date('2026-07-31T00:00:00Z'),
    });
    expect(ctx.customerId).toBe('MRCL001');
    expect(ctx.salesId).toBe('34');
    expect(ctx.poNumber).toBe('7/31/26 DR3W');
    expect(ctx.paymentTerms).toBe('Net 30');
    expect(ctx.billTo.name).toBe('Mattress Recycling Council');
    expect(ctx.billTo.attn).toBe('Ryan Trainer');
    expect(ctx.shipTo).toEqual(ctx.billTo); // same MRC address
    expect(ctx.pendingNote).toBeNull();
  });

  it('OR Eugene: Customer ID + PO stay NULL (pending Mary), statics still present', () => {
    const ctx = buildGpContext({
      statics: STATICS,
      site: {
        customerId: null,
        poSiteSuffix: null,
        pendingNote: 'OR MRC Customer ID + Eugene PO suffix pending Mary (§4.2)',
      },
      invoiceDate: new Date('2026-07-31T00:00:00Z'),
    });
    expect(ctx.customerId).toBeNull();
    expect(ctx.poNumber).toBeNull();
    // The static company identifiers are NOT gated on the per-site unknowns.
    expect(ctx.salesId).toBe('34');
    expect(ctx.paymentTerms).toBe('Net 30');
    expect(ctx.pendingNote).toContain('pending Mary');
  });
});
