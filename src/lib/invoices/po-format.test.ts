// ADR-0041 amendment (rollup §6/§9/§13) — kind-aware PO formats WITH SPACES.

import { describe, expect, it } from 'vitest';
import { buildPoNumberForKind, formatMYY, buildGpContext, type GpBillingStatics } from './gp-identifiers';

const D = new Date('2026-06-30T00:00:00Z');

describe('formatMYY — month/2-digit-year, no day', () => {
  it('6/26 for June 2026', () => {
    expect(formatMYY(D)).toBe('6/26');
    expect(formatMYY(new Date('2026-11-30T00:00:00Z'))).toBe('11/26');
  });
});

describe('buildPoNumberForKind — §6 templates, spaces are significant', () => {
  it('Woodland processing (mid + EOM) → "M/DD/YY DR3 W"', () => {
    expect(buildPoNumberForKind('ca_processing_mid_month', D, 'DR3 W')).toBe('6/30/26 DR3 W');
    expect(buildPoNumberForKind('ca_processing_eom', D, 'DR3 W')).toBe('6/30/26 DR3 W');
  });

  it('Eugene processing → "M/DD/YY DR3 OREGON" (spelled out, not DR3E/DR3O)', () => {
    expect(buildPoNumberForKind('or_processing_eom', D, 'DR3 OREGON')).toBe('6/30/26 DR3 OREGON');
  });

  it('CA transportation → "M/DD/YY TRANS"', () => {
    expect(buildPoNumberForKind('ca_transportation_eom', D, 'DR3 W')).toBe('6/30/26 TRANS');
  });

  it('OR transportation → "M/DD/YY TRANS OR"', () => {
    expect(buildPoNumberForKind('or_transportation_eom', D, 'DR3 OREGON')).toBe('6/30/26 TRANS OR');
  });

  it('OR collections → "M/YY OR COLLECTIONS" (no day)', () => {
    expect(buildPoNumberForKind('or_collection_site_count', D, 'DR3 OREGON')).toBe('6/26 OR COLLECTIONS');
  });

  it('processing with an unknown (null) suffix → null PO (never partial)', () => {
    expect(buildPoNumberForKind('or_processing_eom', D, null)).toBeNull();
  });

  it('transportation/collections POs never depend on the site suffix (kind-fixed)', () => {
    expect(buildPoNumberForKind('ca_transportation_eom', D, null)).toBe('6/30/26 TRANS');
    expect(buildPoNumberForKind('or_collection_site_count', D, null)).toBe('6/26 OR COLLECTIONS');
  });
});

const STATICS: GpBillingStatics = {
  billTo: { name: 'Mattress Recycling Council', attn: 'Ryan Trainer', street: '501 Wythe Street', locality: 'Alexandria VA 22314' },
  salesId: '34',
  paymentTerms: 'Net 30',
};

describe('buildGpContext — kind-aware PO threads through', () => {
  it('Eugene transportation context yields "TRANS OR" PO even with a processing suffix on file', () => {
    const ctx = buildGpContext({
      statics: STATICS,
      site: { customerId: 'MRCL001', poSiteSuffix: 'DR3 OREGON', pendingNote: null },
      invoiceDate: D,
      kind: 'or_transportation_eom',
    });
    expect(ctx.poNumber).toBe('6/30/26 TRANS OR');
  });

  it('without kind, falls back to the plain per-site processing suffix (legacy)', () => {
    const ctx = buildGpContext({
      statics: STATICS,
      site: { customerId: 'MRCL001', poSiteSuffix: 'DR3 W', pendingNote: null },
      invoiceDate: D,
    });
    expect(ctx.poNumber).toBe('6/30/26 DR3 W');
  });
});
