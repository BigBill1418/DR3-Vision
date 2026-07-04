// ADR-0041 D4 — the neutral `invoice_export` JSON (the Great-Plains boundary).
//
// This is a STABLE, adapter-agnostic representation of an approved invoice. The
// GP adapter itself is blocked on Mary's packet (open register), but the
// boundary ships now so the adapter is a CONSUMER of a frozen contract, not a
// refactor. The shape is frozen by `export-json.test.ts` (a contract test): any
// change to the key set is a deliberate, reviewed version bump.
//
// Contract (v1):
//   { schema:'dr3.invoice_export', version:1,
//     invoice:{ id, site_id, kind, billing_month, window:{start,end}, version,
//               supersedes_id, status, total_cents, generated_at, approved_at },
//     lines:[ { line_code, description, quantity, amount_cents, rate_ref, source,
//               position } ] }
// Dates are ISO `YYYY-MM-DD` for @db.Date fields and full ISO instants for
// generated_at/approved_at. Money is integer cents. `quantity` is a decimal
// string (never a float). No PII appears (invoice lines carry row ids/counts,
// never person names — D6).

import type { InvoiceView } from './view';
import type { InvoiceKind, InvoiceStatus, JsonValue } from './types';

export interface InvoiceExportLineV1 {
  line_code: string;
  description: string;
  quantity: string | null;
  amount_cents: number;
  rate_ref: JsonValue;
  source: JsonValue;
  position: number;
}

export interface InvoiceExportV1 {
  schema: 'dr3.invoice_export';
  version: 1;
  invoice: {
    id: string;
    site_id: string;
    kind: InvoiceKind;
    billing_month: string; // YYYY-MM-DD (first of month)
    window: { start: string; end: string }; // YYYY-MM-DD
    version: number;
    supersedes_id: string | null;
    status: InvoiceStatus;
    total_cents: number;
    generated_at: string; // ISO instant
    approved_at: string | null; // ISO instant
  };
  lines: InvoiceExportLineV1[];
}

function dayISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Serialize an invoice view into the frozen v1 export shape. */
export function invoiceExportV1(inv: InvoiceView): InvoiceExportV1 {
  return {
    schema: 'dr3.invoice_export',
    version: 1,
    invoice: {
      id: inv.id,
      site_id: inv.siteId,
      kind: inv.kind,
      billing_month: dayISO(inv.billingMonth),
      window: { start: dayISO(inv.windowStart), end: dayISO(inv.windowEnd) },
      version: inv.version,
      supersedes_id: inv.supersedesId,
      status: inv.status,
      total_cents: inv.totalCents,
      generated_at: inv.generatedAt.toISOString(),
      approved_at: inv.approvedAt ? inv.approvedAt.toISOString() : null,
    },
    lines: inv.lines.map((l) => ({
      line_code: l.lineCode,
      description: l.description,
      quantity: l.quantity,
      amount_cents: l.amountCents,
      rate_ref: l.rateRef,
      source: l.source,
      position: l.position,
    })),
  };
}
