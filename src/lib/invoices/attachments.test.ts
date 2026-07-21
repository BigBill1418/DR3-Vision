// ADR-0041 amendment (rollup §5.1/§6) — invoice attachments[] EOM-only gating.

import { describe, expect, it } from 'vitest';
import { invoiceAttachments } from './attachments';
import type { InvoiceKind } from './types';

describe('invoiceAttachments — commodity breakdown on EOM processing ONLY', () => {
  it('CA EOM processing carries the commodity breakdown (first attachment)', () => {
    const a = invoiceAttachments('ca_processing_eom');
    expect(a).toHaveLength(1);
    expect(a[0]!.kind).toBe('commodity_breakdown');
    expect(a[0]!.render).toBe('commodity-breakdown-pdf');
  });

  it('OR EOM processing carries the commodity breakdown', () => {
    expect(invoiceAttachments('or_processing_eom')).toHaveLength(1);
  });

  it('MID-MONTH carries NO attachment (§6 — EOM only)', () => {
    expect(invoiceAttachments('ca_processing_mid_month')).toEqual([]);
  });

  it('transportation + collection-site-count carry no commodity breakdown', () => {
    const noneKinds: InvoiceKind[] = [
      'ca_transportation_eom',
      'or_transportation_eom',
      'or_collection_site_count',
    ];
    for (const k of noneKinds) expect(invoiceAttachments(k)).toEqual([]);
  });
});
