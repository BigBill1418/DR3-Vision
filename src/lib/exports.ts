// Sprint-1 T-013 - CSV export helpers and column contracts.
//
// Two export shapes ship in Sprint-1:
//   1. MRC Monthly Invoice  (Article 10.4)  -> loadColumnsForMrc()
//   2. SVdP Internal CSV     (Glenn DePrater) -> loadColumnsForSvdp()
//
// COLUMN-NAME RATIONALE
// ---------------------
// ADR-0012 section 7 is the authoritative source for the SVdP-internal
// column shape and locks it to MyMRC verbatim observed field names
// (see docs/MYMRC-INTEGRATION.md "MyMRC data shape"):
//
//   Recycler, Haul ID, Reported Delivery Date, Collection Site,
//   Unit Count at Unload, Recycler Program Unit Count,
//   Recycler Non-Program Unit Count, Pickup Address, Transporter,
//   Reference Number, Recycler Weight, Status, Commodity
//
// SPRINT-1-PLAN T-013 says the MRC Monthly Invoice export "matches the
// MyMRC reconciliation format" - same source. Both exports therefore
// share a column basis. The MRC variant is the literal reconciliation
// shape (what MyMRC will diff us against). The SVdP variant adds DR3-
// side provenance columns at the end so the operator metadata Glenn
// will need is preserved in the historical record while the MyMRC base
// stays intact for any future Glenn-driven reshape.
//
// SVdP additive columns (after the MyMRC block):
//   DR3 Load ID, Arrived At, Unload Duration (s), Operator
//
// These four are charter section 6.4 metadata, never part of MyMRC's
// CSV. They are intentional value-add for the SVdP CFO file, not part
// of the reconciliation contract.
//
// OPEN QUESTIONS (flagged for Bill before V2.1 - see docs/QUESTIONS.md)
// ---------------------------------------------------------------------
// - Q1: Reported Delivery Date - MyMRC's CSV format is MM/DD/YYYY. We
//   emit ISO-8601 yyyy-mm-dd here. CFO/MRC tools may want the slash
//   format. Awaiting Glenn / MRC feedback.
// - Q2: Recycler Program Unit Count vs Recycler Non-Program Unit Count
//   - DR3-Vision tracks total_units only; MyMRC's program/non-program
//   split is downstream MRC bookkeeping. We emit the total in
//   "Unit Count at Unload" and leave program/non-program blank. Glenn
//   confirms or pushes back.
// - Q3: Pickup Address - sources have street/city/state/zip; we emit
//   "street, city, state zip" joined. MyMRC source uses HTML <br>
//   between street and city. We choose comma-delimited; if MRC tooling
//   parses on <br>, we adjust.
// - Q4: Status - for an invoice export, do we emit DR3-Vision's
//   internal status ('submitted'/'verified'/...) or MyMRC's 'Delivered'
//   string? We emit the DR3-Vision internal status since that is the
//   source of truth for billing-readiness; the manager workflow only
//   includes loads in submitted | verified | submitted_to_mymrc |
//   processed so the value is always one of those four.
// - Q5: Commodity - MyMRC always shows "Whole Mattresses and
//   Foundations". We hard-code that string for every row in MVP. If
//   DR3 ever exports box-springs-only or another commodity, this needs
//   to come from data.

const CRLF = '\r\n';
const COMMODITY_DEFAULT = 'Whole Mattresses and Foundations';

// --- CSV emit ---------------------------------------------------------

/**
 * RFC 4180 field escape:
 *  - null/undefined -> ''
 *  - field containing comma, quote, CR, or LF is wrapped in quotes
 *  - embedded quotes are doubled
 */
export function escapeCsvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (s.length === 0) return '';
  const needsQuotes = /[",\r\n]/.test(s);
  if (!needsQuotes) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Render rows as RFC 4180 CSV text. Header row is `columns` joined
 * (each header is escaped); each data row pulls row[col] for every
 * column in `columns`. Lines are CRLF-terminated; trailing CRLF.
 */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<string>,
): string {
  const header = columns.map(escapeCsvField).join(',');
  const lines = [header];
  for (const row of rows) {
    const cells = columns.map((c) => escapeCsvField(row[c]));
    lines.push(cells.join(','));
  }
  return lines.join(CRLF) + CRLF;
}

// --- Period parsing ---------------------------------------------------

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Parse a YYYY-MM month string into a half-open UTC interval
 * [start, end). `start` = first instant of the named month (UTC);
 * `end` = first instant of the *next* month (UTC, exclusive).
 *
 * Throws on invalid input - callers should catch and 400.
 */
export function monthRange(monthStr: string): { start: Date; end: Date } {
  const m = MONTH_RE.exec(monthStr);
  if (!m) throw new Error(`invalid month: expected YYYY-MM, got "${monthStr}"`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1..12
  if (year < 2024 || year > 2100) {
    throw new Error(`invalid month: year out of operational range: ${year}`);
  }
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, end };
}

// --- Column contracts -------------------------------------------------

const MYMRC_COLUMNS: ReadonlyArray<string> = [
  'Recycler',
  'Haul ID',
  'Reported Delivery Date',
  'Collection Site',
  'Unit Count at Unload',
  'Recycler Program Unit Count',
  'Recycler Non-Program Unit Count',
  'Pickup Address',
  'Transporter',
  'Reference Number',
  'Recycler Weight',
  'Status',
  'Commodity',
];

const SVDP_EXTRA_COLUMNS: ReadonlyArray<string> = [
  'DR3 Load ID',
  'Arrived At',
  'Unload Duration (s)',
  'Operator',
];

export function loadColumnsForMrc(): string[] {
  return [...MYMRC_COLUMNS];
}

export function loadColumnsForSvdp(): string[] {
  return [...MYMRC_COLUMNS, ...SVDP_EXTRA_COLUMNS];
}

// --- Row shaping ------------------------------------------------------

/**
 * The Prisma shape this module needs for each load row. Defined here
 * so the route handlers can assemble select clauses that exactly
 * match - no broad selects.
 */
export interface LoadRowInput {
  id: string;
  external_mymrc_haul_id: string | null;
  bol_number: string | null;
  arrived_at: Date | null;
  unload_finished_at: Date | null;
  unload_duration_seconds: number | null;
  total_units: number | null;
  weight_lbs: number | null;
  status: string;
  source: {
    name: string;
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  transporter: { name: string } | null;
  assigned_operator: { name: string } | null;
}

export interface SiteRowInput {
  code: string;
  name: string;
}

function recyclerName(site: SiteRowInput): string {
  // MyMRC labels recyclers as "DR3 Eugene" or "DR3 Woodland"; CLAUDE.md
  // hard-rule #1 forbids "Stockton" anywhere, so the only valid codes
  // are 'eugene' and 'woodland'.
  const cap = site.code.charAt(0).toUpperCase() + site.code.slice(1);
  return `DR3 ${cap}`;
}

function isoDate(d: Date | null): string {
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

function isoDateTime(d: Date | null): string {
  if (!d) return '';
  return d.toISOString();
}

function pickupAddress(s: LoadRowInput['source']): string {
  if (!s) return '';
  const cityZip = [s.city, s.state, s.zip].filter(Boolean).join(' ').trim();
  return [s.street, cityZip].filter((p) => p && p.length > 0).join(', ');
}

/**
 * Shape a load row into the MRC-invoice column dict (MyMRC field
 * names only; no DR3-side metadata).
 */
export function buildMrcRow(load: LoadRowInput, site: SiteRowInput): Record<string, unknown> {
  return {
    Recycler: recyclerName(site),
    'Haul ID': load.external_mymrc_haul_id ?? '',
    'Reported Delivery Date': isoDate(load.unload_finished_at ?? load.arrived_at),
    'Collection Site': load.source?.name ?? '',
    'Unit Count at Unload': load.total_units ?? '',
    'Recycler Program Unit Count': '', // see Q2
    'Recycler Non-Program Unit Count': '', // see Q2
    'Pickup Address': pickupAddress(load.source),
    Transporter: load.transporter?.name ?? '',
    'Reference Number': load.bol_number ?? '',
    'Recycler Weight': load.weight_lbs ?? '',
    Status: load.status,
    Commodity: COMMODITY_DEFAULT,
  };
}

/**
 * Shape a load row into the SVdP column dict (MyMRC fields + four DR3
 * provenance columns).
 */
export function buildSvdpRow(load: LoadRowInput, site: SiteRowInput): Record<string, unknown> {
  return {
    ...buildMrcRow(load, site),
    'DR3 Load ID': load.id,
    'Arrived At': isoDateTime(load.arrived_at),
    'Unload Duration (s)': load.unload_duration_seconds ?? '',
    Operator: load.assigned_operator?.name ?? '',
  };
}

// --- Status whitelist -------------------------------------------------

/**
 * The four billing-ready statuses. Loads in expected/arrived/...
 * /finished/rejected are explicitly excluded from invoice exports.
 * Defined here so both routes use the exact same filter.
 */
export const INVOICE_STATUSES = [
  'submitted',
  'verified',
  'submitted_to_mymrc',
  'processed',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
