// ADR-0041 amendment (rollup §5.1/§6) — the invoice `attachments[]` concept.
//
// Rick confirmed (§5.1) the outbound COMMODITY BREAKDOWN is sent "as a breakdown
// along with the invoice", and (§6) EOM ONLY — never with the mid-month invoice.
// The commodity mapping is NOT a billing input (invoice math stays single-line);
// the breakdown is a COMPANION document that rides the EOM invoice.
//
// Modeling note (divergence from the idealized spec): the handoff speaks of
// `invoices.attachments[]` as if it were a stored column. There is NO such column
// on the `invoices` table (the schema foundation added none), and none is needed:
// an attachment is fully DERIVED from (kind, billing period) — the commodity
// breakdown is rendered on demand from `outbound_materials` + the landfilled-unit
// movements for the window (see src/lib/commodity/*). So `attachments[]` is a
// COMPUTED descriptor list, not persisted state. This keeps the money row
// immutable and avoids a schema migration for a purely presentational artifact.
//
// Gating (§6): the commodity breakdown attaches to the EOM PROCESSING invoices
// (`ca_processing_eom`, `or_processing_eom`) — the two rows §6 marks "with
// commodity attachment". It NEVER attaches to a mid-month invoice, and the
// transportation / collection-site-count EOM invoices carry no commodity
// breakdown (their basis is freight/rental/site-count, not processed units).

import type { InvoiceKind } from './types';

/** The kinds of companion documents an invoice can carry (extensible). */
export type InvoiceAttachmentKind = 'commodity_breakdown';

/**
 * A descriptor for a companion document that rides an invoice. `render` names the
 * builder that produces the bytes on demand (the descriptor itself carries no
 * bytes — the artifact is rendered lazily at download/delivery time).
 */
export interface InvoiceAttachmentDescriptor {
  kind: InvoiceAttachmentKind;
  /** Human label (email/summary surfaces). */
  label: string;
  /** The on-demand renderer that produces this attachment. */
  render: 'commodity-breakdown-pdf';
  /** Suggested download filename stem (no extension). */
  filenameStem: string;
}

/** EOM processing kinds — the only kinds that carry the commodity breakdown (§6). */
const COMMODITY_BREAKDOWN_KINDS: readonly InvoiceKind[] = ['ca_processing_eom', 'or_processing_eom'];

/**
 * The companion attachments an invoice of this kind carries. EOM ONLY (§6): a
 * mid-month invoice (`ca_processing_mid_month`) always returns `[]`. The FIRST
 * (currently only) attachment on an EOM processing invoice is the monthly
 * commodity breakdown (§5.1). Pure — the gating is a property of the kind.
 */
export function invoiceAttachments(kind: InvoiceKind): InvoiceAttachmentDescriptor[] {
  if (!COMMODITY_BREAKDOWN_KINDS.includes(kind)) return [];
  return [
    {
      kind: 'commodity_breakdown',
      label: 'Monthly commodity breakdown',
      render: 'commodity-breakdown-pdf',
      filenameStem: 'commodity-breakdown',
    },
  ];
}
