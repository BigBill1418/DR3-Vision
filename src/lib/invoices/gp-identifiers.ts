// ADR-0041 amendment §4.2 — the Great-Plains identifier resolution, pure.
//
// GP needs a fixed set of header identifiers on every invoice Mary types:
// Bill-To / Ship-To (the MRC address — same for both), Customer ID, Sales ID,
// PO number, Payment Terms. The static + per-site pieces live in
// `gp_billing_config` / `gp_site_billing_config`; this module assembles them into
// the shape the v2 export carries. It is PURE (no DB) so the PO formatting and
// the "never invent an unknown" rule are unit-tested directly.
//
// The honesty rule (§4.2): CA identifiers are confirmed and seeded; OR's MRC
// Customer ID and Eugene's PO suffix are UNKNOWN (pending Mary). An unknown is
// rendered as `null` — NEVER guessed (no DR3E/DR3O invention). A null PO suffix
// yields a null PO number, not a partial `"7/31/26 "`.

/** The MRC postal address (same block for Bill-To and Ship-To). */
export interface GpAddress {
  name: string;
  attn: string | null;
  street: string;
  locality: string; // "Alexandria VA 22314"
}

/** Company-wide GP statics (the singleton `gp_billing_config`). */
export interface GpBillingStatics {
  billTo: GpAddress;
  salesId: string;
  paymentTerms: string;
}

/** Per-site GP identifiers (the `gp_site_billing_config` row; nulls are honest). */
export interface GpSiteIdentifiers {
  customerId: string | null;
  poSiteSuffix: string | null;
  pendingNote: string | null;
}

/** The assembled GP header the v2 export renders. */
export interface GpContext {
  billTo: GpAddress;
  shipTo: GpAddress; // === billTo (MRC ships nothing; same address)
  customerId: string | null;
  salesId: string;
  poNumber: string | null;
  paymentTerms: string;
  pendingNote: string | null;
}

/**
 * Format a `@db.Date` as GP's `M/DD/YY` (month un-padded, day 2-digit, year
 * 2-digit). Reads UTC calendar components — the store invariant (`src/lib/time.ts`)
 * is that a `@db.Date`'s UTC Y/M/D ARE the Pacific calendar day, so no zone shift.
 * e.g. 2026-07-31 → "7/31/26".
 */
export function formatMDDYY(d: Date): string {
  const m = d.getUTCMonth() + 1; // un-padded
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${m}/${dd}/${yy}`;
}

/**
 * Build the PO number `"M/DD/YY <site_suffix>"` from the invoice date and the
 * site's PO suffix. Returns `null` when the suffix is unknown (Eugene, pending
 * Mary) — the identifier is never partially invented.
 *
 * NOTE (flagged for Mary): the date used is the invoice's window-end (the EOM
 * date, or the 15th for a mid-month invoice). Confirm this matches the date Mary
 * types into the GP PO field before the adapter consumes it.
 */
export function buildPoNumber(invoiceDate: Date, poSiteSuffix: string | null): string | null {
  if (!poSiteSuffix) return null;
  return `${formatMDDYY(invoiceDate)} ${poSiteSuffix}`;
}

/** Assemble the GP header context from the statics + per-site identifiers. */
export function buildGpContext(args: {
  statics: GpBillingStatics;
  site: GpSiteIdentifiers;
  invoiceDate: Date;
}): GpContext {
  return {
    billTo: args.statics.billTo,
    shipTo: args.statics.billTo,
    customerId: args.site.customerId,
    salesId: args.statics.salesId,
    poNumber: buildPoNumber(args.invoiceDate, args.site.poSiteSuffix),
    paymentTerms: args.statics.paymentTerms,
    pendingNote: args.site.pendingNote,
  };
}
