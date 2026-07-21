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

import type { InvoiceKind } from './types';

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
 * Format a `@db.Date` as GP's `M/YY` (month un-padded, year 2-digit — no day).
 * Used by the OR collection-site-count PO, which §6 formats without a day
 * (`M/YY OR COLLECTIONS`). e.g. 2026-06-30 → "6/26".
 */
export function formatMYY(d: Date): string {
  const m = d.getUTCMonth() + 1;
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${m}/${yy}`;
}

/**
 * Build the PO number `"M/DD/YY <site_suffix>"` from the invoice date and the
 * site's PO suffix. Returns `null` when the suffix is unknown — the identifier is
 * never partially invented. This is the base builder for the PROCESSING PO (whose
 * suffix is the confirmed per-site `po_site_suffix`: "DR3 W" / "DR3 OREGON");
 * transportation and collections POs are kind-derived — see {@link buildPoNumberForKind}.
 *
 * NOTE (flagged for Mary): the date used is the invoice's window-end (the EOM
 * date, or the 15th for a mid-month invoice). Confirm this matches the date Mary
 * types into the GP PO field before the adapter consumes it.
 */
export function buildPoNumber(invoiceDate: Date, poSiteSuffix: string | null): string | null {
  if (!poSiteSuffix) return null;
  return `${formatMDDYY(invoiceDate)} ${poSiteSuffix}`;
}

/**
 * The PO number for a given invoice KIND (rollup §6/§9/§13). The PO suffix and
 * date format both depend on the invoice kind, VERBATIM from the real invoice
 * PDFs — WITH SPACES (a `DR3W` / `TRANSOR` would not match GP):
 *
 *   ca_processing_mid_month | ca_processing_eom → `M/DD/YY <suffix>`  (Woodland: "DR3 W")
 *   or_processing_eom                           → `M/DD/YY <suffix>`  (Eugene:   "DR3 OREGON")
 *   ca_transportation_eom                       → `M/DD/YY TRANS`
 *   or_transportation_eom                       → `M/DD/YY TRANS OR`
 *   or_collection_site_count                    → `M/YY OR COLLECTIONS`  (no day)
 *
 * Processing POs use the confirmed per-site `poSiteSuffix`; a null suffix yields a
 * null PO (never partially invented). The transportation/collection suffixes are
 * kind-fixed constants confirmed in §6, so they are never null.
 */
export function buildPoNumberForKind(
  kind: InvoiceKind,
  invoiceDate: Date,
  poSiteSuffix: string | null,
): string | null {
  switch (kind) {
    case 'ca_processing_mid_month':
    case 'ca_processing_eom':
    case 'or_processing_eom':
      return buildPoNumber(invoiceDate, poSiteSuffix);
    case 'ca_transportation_eom':
      return `${formatMDDYY(invoiceDate)} TRANS`;
    case 'or_transportation_eom':
      return `${formatMDDYY(invoiceDate)} TRANS OR`;
    case 'or_collection_site_count':
      return `${formatMYY(invoiceDate)} OR COLLECTIONS`;
  }
}

/**
 * Assemble the GP header context from the statics + per-site identifiers. When
 * `kind` is supplied the PO number is kind-aware (§6 — the correct path for a
 * real invoice); without it, the PO falls back to the plain per-site processing
 * suffix (legacy callers / direct tests).
 */
export function buildGpContext(args: {
  statics: GpBillingStatics;
  site: GpSiteIdentifiers;
  invoiceDate: Date;
  kind?: InvoiceKind;
}): GpContext {
  return {
    billTo: args.statics.billTo,
    shipTo: args.statics.billTo,
    customerId: args.site.customerId,
    salesId: args.statics.salesId,
    poNumber: args.kind
      ? buildPoNumberForKind(args.kind, args.invoiceDate, args.site.poSiteSuffix)
      : buildPoNumber(args.invoiceDate, args.site.poSiteSuffix),
    paymentTerms: args.statics.paymentTerms,
    pendingNote: args.site.pendingNote,
  };
}
