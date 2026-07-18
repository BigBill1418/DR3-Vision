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
import type { InvoiceKind, InvoiceMode, InvoiceStatus, JsonValue } from './types';
import { LINE_CODE } from './types';
import type { GpContext } from './gp-identifiers';
import { formatMDDYY } from './gp-identifiers';
import { InvoiceInvariantError } from './view';

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

// ────────────────────────────────────────────────────────────────────────
// v2 (ADR-0041 amendment §4.2) — the two-line GP invoice, C-1 contract bump.
//
// v1 above is FROZEN and unchanged (the GP adapter must not re-derive from line
// JSON — C-1). v2 ships ALONGSIDE it, carrying (a) the GP header identifiers
// (Bill-To/Ship-To, Customer ID, Sales ID, PO, Payment Terms), (b) the pilot
// `mode` + the §8.3 program/non-program split + the trade-discount fields, and
// (c) the GP presentation: the §4.2 TWO-LINE processing structure
//   Line 1 (header)   → "total units processed M/DD/YY"        Each 0 · Ext 0
//   Line 2 (billable) → "MRC-Processed Units DR3 <SiteName>"   Each <rate> · Ext <units×rate>
// then Subtotal / Misc / Tax / Freight / Trade Discount / Total.
//
// The leaf `lines` (v1's provenance list) are ALSO carried so nothing is lost —
// `gp` is a presentation over them, never a replacement. `gp.totals.total_cents`
// is asserted to reconcile to `invoice.total_cents` at build time (ADR-0033
// tripwire): a GP total that disagrees with the stored invoice is a defect.
//
// For non-processing kinds (transportation, collection-site-count) the §4.2
// two-line "MRC-Processed Units" shape does not apply; `gp.presentation` names
// the shape used and `gp_lines` lists each billable leaf. `subtotal_cents` is
// always Σ gp_lines.extended_cents, and the reconciliation invariant holds for
// every kind.

/** One GP invoice line (the presentation, not the leaf provenance). */
export interface GpExportLineV2 {
  /** GP "Location" cell (shown on the header line; null elsewhere). */
  location: string | null;
  /** GP "Item" code — empty per §4.2. */
  item: string;
  description: string;
  /** GP unit of measure — 'UNITSMO' on the billable processing line. */
  unit_of_measure: string | null;
  /** Decimal string (never a float); null on a header line. */
  quantity: string | null;
  /** GP "Each". */
  unit_price_cents: number;
  /** GP "Extended". */
  extended_cents: number;
}

export interface GpExportTotalsV2 {
  subtotal_cents: number; // Σ gp_lines.extended_cents
  misc_cents: number;
  tax_cents: number;
  freight_cents: number;
  /** POSITIVE cents subtracted (the mid-month bill); 0 when none. */
  trade_discount_cents: number;
  /** subtotal + misc + tax + freight − trade_discount (== invoice.total_cents). */
  total_cents: number;
}

export interface GpExportHeaderV2 {
  bill_to: GpContext['billTo'];
  ship_to: GpContext['shipTo'];
  customer_id: string | null;
  sales_id: string;
  po_number: string | null;
  payment_terms: string;
  /** Why any identifier is null (pending Mary), or null when all are known. */
  pending_note: string | null;
}

export type GpPresentation = 'processing' | 'transportation' | 'collection_site_count';

export interface InvoiceExportV2 {
  schema: 'dr3.invoice_export';
  version: 2;
  invoice: {
    id: string;
    site_id: string;
    kind: InvoiceKind;
    mode: InvoiceMode;
    billing_month: string;
    window: { start: string; end: string };
    version: number;
    supersedes_id: string | null;
    status: InvoiceStatus;
    total_cents: number;
    program_units_processed: string | null;
    non_program_units_processed: string | null;
    trade_discount_cents: number | null;
    trade_discount_reference_invoice_id: string | null;
    generated_at: string;
    approved_at: string | null;
  };
  gp: {
    presentation: GpPresentation;
    header: GpExportHeaderV2;
    lines: GpExportLineV2[];
    totals: GpExportTotalsV2;
  };
  /** The v1 leaf provenance lines, carried unchanged (never lost). */
  lines: InvoiceExportLineV1[];
}

/** The context the v2 export needs beyond the invoice view (site name + GP ids). */
export interface GpExportContext {
  siteName: string;
  gp: GpContext;
}

function presentationForKind(kind: InvoiceKind): GpPresentation {
  if (kind === 'ca_transportation_eom' || kind === 'or_transportation_eom') return 'transportation';
  if (kind === 'or_collection_site_count') return 'collection_site_count';
  return 'processing';
}

/** Σ line amounts for a set of line codes. */
function sumCodes(inv: InvoiceView, codes: readonly string[]): number {
  return inv.lines
    .filter((l) => codes.includes(l.lineCode))
    .reduce((acc, l) => acc + l.amountCents, 0);
}

/** Read an integer `rate_cents` out of a leaf line's rate_ref, or null. */
function rateCentsOf(rateRef: JsonValue): number | null {
  if (rateRef && typeof rateRef === 'object' && !Array.isArray(rateRef)) {
    const v = (rateRef as { [k: string]: JsonValue })['rate_cents'];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function decStr(n: number | null): string | null {
  return n == null ? null : String(n);
}

/** Build the §4.2 two-line processing presentation. */
function processingGpLines(inv: InvoiceView, ctx: GpExportContext): GpExportLineV2[] {
  const chargeLine = inv.lines.find(
    (l) => l.lineCode === LINE_CODE.processing || l.lineCode === LINE_CODE.midMonthProcessing,
  );
  const programUnits = inv.programUnitsProcessed;
  const extended = chargeLine?.amountCents ?? 0;
  // Unit price: authoritative from the charge line's rate_ref; fall back to the
  // resolved-rate-free derivation only when rate_ref carries no rate_cents (never
  // for a Vision-generated line — the resolver always stamps it).
  const rate =
    (chargeLine ? rateCentsOf(chargeLine.rateRef) : null) ??
    (programUnits && programUnits !== 0 ? Math.round(extended / programUnits) : 0);
  return [
    {
      location: ctx.siteName,
      item: '',
      description: `total units processed ${formatMDDYY(inv.windowEnd)}`,
      unit_of_measure: null,
      quantity: null,
      unit_price_cents: 0,
      extended_cents: 0,
    },
    {
      location: null,
      item: '',
      description: `MRC-Processed Units DR3 ${ctx.siteName}`,
      unit_of_measure: 'UNITSMO',
      quantity: decStr(programUnits),
      unit_price_cents: rate,
      extended_cents: extended,
    },
  ];
}

/** One gp_line per billable leaf (transportation / collection-site-count). */
function leafGpLines(inv: InvoiceView, codes: readonly string[]): GpExportLineV2[] {
  return inv.lines
    .filter((l) => codes.includes(l.lineCode))
    .map((l) => ({
      location: null,
      item: '',
      description: l.description,
      unit_of_measure: null,
      quantity: l.quantity,
      unit_price_cents: rateCentsOf(l.rateRef) ?? 0,
      extended_cents: l.amountCents,
    }));
}

const TRANSPORT_CODES = [
  LINE_CODE.freight,
  LINE_CODE.eventFreight,
  LINE_CODE.fuel,
  LINE_CODE.rentals,
] as const;

/**
 * Serialize an invoice into the v2 GP export. Reconciles
 * `gp.totals.total_cents === invoice.total_cents` (throws
 * {@link InvoiceInvariantError} otherwise — the total we hand GP must equal the
 * stored, approved total).
 */
export function invoiceExportV2(inv: InvoiceView, ctx: GpExportContext): InvoiceExportV2 {
  const presentation = presentationForKind(inv.kind);

  let gpLines: GpExportLineV2[];
  let miscCents = 0;
  let tradeDiscountCents = 0;
  if (presentation === 'processing') {
    gpLines = processingGpLines(inv, ctx);
    miscCents = sumCodes(inv, [LINE_CODE.incentives, LINE_CODE.eventMisc]);
    // offset is stored negative → positive trade discount. `|| 0` normalizes the
    // `-0` that negating a zero offset sum would otherwise produce (a `-0` in a
    // money field is a defect, not a value).
    tradeDiscountCents = -sumCodes(inv, [LINE_CODE.eomOffset]) || 0;
  } else if (presentation === 'transportation') {
    gpLines = leafGpLines(inv, TRANSPORT_CODES);
  } else {
    gpLines = leafGpLines(inv, [LINE_CODE.satellite, LINE_CODE.manual]);
  }

  const subtotalCents = gpLines.reduce((acc, l) => acc + l.extended_cents, 0);
  const totals: GpExportTotalsV2 = {
    subtotal_cents: subtotalCents,
    misc_cents: miscCents,
    tax_cents: 0,
    freight_cents: 0,
    trade_discount_cents: tradeDiscountCents,
    total_cents: subtotalCents + miscCents - tradeDiscountCents,
  };

  // ADR-0033 tripwire: the GP total MUST equal the stored invoice total.
  if (totals.total_cents !== inv.totalCents) {
    throw new InvoiceInvariantError({
      invoiceId: inv.id,
      storedTotal: inv.totalCents,
      lineSum: totals.total_cents,
    });
  }

  return {
    schema: 'dr3.invoice_export',
    version: 2,
    invoice: {
      id: inv.id,
      site_id: inv.siteId,
      kind: inv.kind,
      mode: inv.mode,
      billing_month: dayISO(inv.billingMonth),
      window: { start: dayISO(inv.windowStart), end: dayISO(inv.windowEnd) },
      version: inv.version,
      supersedes_id: inv.supersedesId,
      status: inv.status,
      total_cents: inv.totalCents,
      program_units_processed: decStr(inv.programUnitsProcessed),
      non_program_units_processed: decStr(inv.nonProgramUnitsProcessed),
      trade_discount_cents: inv.tradeDiscountCents,
      trade_discount_reference_invoice_id: inv.tradeDiscountReferenceInvoiceId,
      generated_at: inv.generatedAt.toISOString(),
      approved_at: inv.approvedAt ? inv.approvedAt.toISOString() : null,
    },
    gp: {
      presentation,
      header: {
        bill_to: ctx.gp.billTo,
        ship_to: ctx.gp.shipTo,
        customer_id: ctx.gp.customerId,
        sales_id: ctx.gp.salesId,
        po_number: ctx.gp.poNumber,
        payment_terms: ctx.gp.paymentTerms,
        pending_note: ctx.gp.pendingNote,
      },
      lines: gpLines,
      totals,
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
