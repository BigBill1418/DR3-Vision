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
import { GP_ITEM_CODE, MILES_0_MEMBER_CODES, type GpItemCode } from './item-codes';
import { invoiceAttachments, type InvoiceAttachmentDescriptor } from './attachments';
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
  /**
   * GP "Item" code — one of the 7 LOCKED codes (rollup §9): LOCATION / UNITSMO /
   * REIMBO / EVENTO / MILES 0 / FUEL / OREGON MATTRESS. Verbatim from the real
   * June-2026 invoice PDFs (§10); supersedes the PR-#128 empty-string assumption.
   */
  item: GpItemCode;
  description: string;
  /** GP unit of measure — currently unused by the locked taxonomy (always null). */
  unit_of_measure: string | null;
  /** Decimal string (never a float); null on a LOCATION header/spacer line. */
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
  /**
   * rollup §5.1/§6 — the companion documents that ride this invoice. EOM
   * processing invoices carry the monthly commodity breakdown; mid-month and
   * every other kind carry `[]`. Descriptors only (rendered on demand).
   */
  attachments: InvoiceAttachmentDescriptor[];
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

/** A $0 GP LOCATION section header/spacer (rollup §9/§10). */
function locationSpacer(description: string, location: string | null = null): GpExportLineV2 {
  return {
    location,
    item: GP_ITEM_CODE.location,
    description,
    unit_of_measure: null,
    quantity: null,
    unit_price_cents: 0,
    extended_cents: 0,
  };
}

/**
 * A single-quantity AGGREGATE GP line (REIMBO / EVENTO / MILES 0 / FUEL): GP
 * renders these as `1 <CODE> … $extended`, so quantity is "1" and Each == Ext.
 */
function aggregateLine(item: GpItemCode, description: string, extendedCents: number): GpExportLineV2 {
  return {
    location: null,
    item,
    description,
    unit_of_measure: null,
    quantity: '1',
    unit_price_cents: extendedCents,
    extended_cents: extendedCents,
  };
}

/**
 * Build the processing presentation, matching the real June-2026 invoice PDFs
 * (§10): a LOCATION header + the UNITSMO charge, then (when present) a LOCATION
 * spacer + REIMBO incentive line and a LOCATION spacer + EVENTO event-labor line.
 * The B7/B8 amounts are FIRST-CLASS subtotal lines here (not "misc") — that is
 * how MRC's real invoice reads. The trade-discount offset (B22) is NOT a line;
 * it becomes the GP Trade-discount TOTAL field (see invoiceExportV2 totals).
 */
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

  const lines: GpExportLineV2[] = [
    locationSpacer(`total units processed ${formatMDDYY(inv.windowEnd)}`, ctx.siteName),
    {
      location: null,
      item: GP_ITEM_CODE.unitsMo,
      description: `MRC-Processed Units DR3 ${ctx.siteName}`,
      unit_of_measure: null,
      quantity: decStr(programUnits),
      unit_price_cents: rate,
      extended_cents: extended,
    },
  ];

  const incentive = inv.lines.find((l) => l.lineCode === LINE_CODE.incentives);
  if (incentive) {
    lines.push(locationSpacer('Incentive program'));
    lines.push(aggregateLine(GP_ITEM_CODE.reimbo, incentive.description, incentive.amountCents));
  }

  // B8 event misc renders (0¢, source.pending) until the events feed is wired —
  // so the EVENTO section is never silently absent (matches the composer's D3 rule).
  const eventMisc = inv.lines.find((l) => l.lineCode === LINE_CODE.eventMisc);
  if (eventMisc) {
    lines.push(locationSpacer('Misc Events'));
    lines.push(aggregateLine(GP_ITEM_CODE.evento, eventMisc.description, eventMisc.amountCents));
  }

  return lines;
}

/**
 * Build the transportation presentation with the §9 MILES 0 aggregation: regular
 * freight + event transportation + container rental collapse into ONE `MILES 0`
 * line; fuel keeps its own `FUEL` line. The three MILES-0 member leaves are still
 * stored separately on the invoice (full provenance in `lines`); this is the
 * GP-presentation rollup only. OR carries no fuel leaf by construction, so no
 * FUEL line is emitted there.
 */
function transportationGpLines(inv: InvoiceView, ctx: GpExportContext): GpExportLineV2[] {
  const lines: GpExportLineV2[] = [];
  const miles0Cents = inv.lines
    .filter((l) => MILES_0_MEMBER_CODES.includes(l.lineCode))
    .reduce((acc, l) => acc + l.amountCents, 0);
  // Always emit the MILES 0 line for a transportation invoice — freight/rental is
  // the invoice's reason for being; a 0¢ MILES 0 is honest, never absent.
  lines.push(
    aggregateLine(
      GP_ITEM_CODE.miles0,
      `MRC Freight & Rental — ${ctx.siteName} ${formatMDDYY(inv.windowEnd)}`,
      miles0Cents,
    ),
  );

  const fuel = inv.lines.find((l) => l.lineCode === LINE_CODE.fuel);
  if (fuel) {
    lines.push(aggregateLine(GP_ITEM_CODE.fuel, fuel.description, fuel.amountCents));
  }
  return lines;
}

/**
 * Build the OR collection-site-count presentation: one `OREGON MATTRESS` line per
 * satellite site, carrying the site's real mattress count × $2.25 (§9/§10).
 */
function collectionGpLines(inv: InvoiceView): GpExportLineV2[] {
  return inv.lines
    .filter((l) => l.lineCode === LINE_CODE.satellite || l.lineCode === LINE_CODE.manual)
    .map((l) => ({
      location: null,
      item: GP_ITEM_CODE.oregonMattress,
      description: l.description,
      unit_of_measure: null,
      quantity: l.quantity,
      unit_price_cents: rateCentsOf(l.rateRef) ?? 0,
      extended_cents: l.amountCents,
    }));
}

/**
 * Serialize an invoice into the v2 GP export. Reconciles
 * `gp.totals.total_cents === invoice.total_cents` (throws
 * {@link InvoiceInvariantError} otherwise — the total we hand GP must equal the
 * stored, approved total).
 */
export function invoiceExportV2(inv: InvoiceView, ctx: GpExportContext): InvoiceExportV2 {
  const presentation = presentationForKind(inv.kind);

  let gpLines: GpExportLineV2[];
  let tradeDiscountCents = 0;
  if (presentation === 'processing') {
    gpLines = processingGpLines(inv, ctx);
    // offset is stored negative → positive trade discount. `|| 0` normalizes the
    // `-0` that negating a zero offset sum would otherwise produce (a `-0` in a
    // money field is a defect, not a value).
    tradeDiscountCents = -sumCodes(inv, [LINE_CODE.eomOffset]) || 0;
  } else if (presentation === 'transportation') {
    gpLines = transportationGpLines(inv, ctx);
  } else {
    gpLines = collectionGpLines(inv);
  }

  // rollup §9/§10 — REIMBO/EVENTO (processing) and MILES 0/FUEL (transportation)
  // are FIRST-CLASS subtotal lines now, matching the real invoice PDFs, so `misc`
  // and `freight` are always 0 (their amounts live in gp_lines, not a summary
  // bucket). The reconciliation invariant below still guards the grand total.
  const subtotalCents = gpLines.reduce((acc, l) => acc + l.extended_cents, 0);
  const totals: GpExportTotalsV2 = {
    subtotal_cents: subtotalCents,
    misc_cents: 0,
    tax_cents: 0,
    freight_cents: 0,
    trade_discount_cents: tradeDiscountCents,
    total_cents: subtotalCents - tradeDiscountCents,
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
    attachments: invoiceAttachments(inv.kind),
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
