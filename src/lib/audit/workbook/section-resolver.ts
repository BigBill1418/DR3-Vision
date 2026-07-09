// ADR-0049 / ADR-0048 — worksheet SECTION-LABEL resolver.
//
// WHY this exists: the ADR-0039 parser (parser.ts) resolved category tabs by
// SHEET NAME. July's workbook broke that assumption — Kelsey's template dropped
// the month prefix from the category tab names (2026-07-09 rollup §3.2):
//   June: "June26 Commodities"          July: "Commodities"
//   June: "June2026 inb trans charges"  July: "inb trans charges"
//   June: "June2026All"                 July: "July2026All"  (kept full prefix)
// Sheet-name matching is therefore dead as a PRIMARY key. The durable signal is
// the ROW-2 SECTION LABEL (e.g. "INBOUND WITH TRANS CHARGE - Woodland") which is
// stable across months, backed by header-row column signatures and a
// prefix-stripping name fallback. This module classifies every sheet into a
// `WorksheetSemanticType` so downstream consumers (the ADR-0049 D12
// daily-adapter finalization, and the ADR-0048 promotion pipeline) address tabs
// by MEANING, not by a name Kelsey may drift again.
//
// Pure + IO-free: `resolveSectionType` takes plain projections; the exceljs
// entry point `classifyWorkbookSheets` extracts those projections and delegates.
// It NEVER throws on an unrecognized sheet — it returns 'unknown' (the workbook
// is operator-authored and will contain shapes we have not catalogued yet).
//
// Cell coercion mirrors parser.ts / daily-adapter.ts verbatim so formula cells,
// dates and shared-string cells read identically across the audit stack.

import ExcelJS from 'exceljs';

export type WorksheetSemanticType =
  | 'inb_trans_charges'
  | 'inb_no_trans_charge'
  | 'incentive_unpaid'
  | 'nonprogram'
  | 'renovation'
  | 'commodities'
  | 'processed'
  | 'container_rentals'
  | 'trans_summary'
  | 'summary'
  | 'events'
  | 'all_inbounds'
  | 'variables'
  | 'list'
  | 'fuel'
  | 'day'
  | 'unknown';

export interface ResolveInput {
  /** Worksheet name (e.g. "June2026 inb trans charges", "DAY6", "Commodities"). */
  name: string;
  /** Row-2 cell texts (the section-label row on category tabs), if extracted. */
  row2?: (string | null)[];
  /** Candidate header rows keyed by 1-based row index → that row's cell texts. */
  headerRows?: Record<number, (string | null)[]>;
}

// ────────────────────────────────────────────────────────────────────────
// Cell helpers (identical coercion to parser.ts — keep in lock-step)
// ────────────────────────────────────────────────────────────────────────

export function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'result' in value && value.result !== undefined) {
    return cellText(value.result as ExcelJS.CellValue);
  }
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text.trim() || null;
  }
  return null;
}

export function cellNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'result' in value) {
    const r = (value as { result?: unknown }).result;
    if (typeof r === 'number') return r;
  }
  const t = cellText(value);
  if (t === null) return null;
  const n = Number(t.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Read a contiguous run of cells from `rowIndex` as coerced text (1-based, inclusive). */
export function readSectionRow(
  ws: ExcelJS.Worksheet,
  rowIndex: number,
  colCount: number,
): (string | null)[] {
  const row = ws.getRow(rowIndex);
  const out: (string | null)[] = [];
  for (let c = 1; c <= colCount; c++) out.push(cellText(row.getCell(c).value));
  return out;
}

/** Read a contiguous run of cells from `rowIndex` as coerced numbers (1-based, inclusive). */
export function readSectionNumbers(
  ws: ExcelJS.Worksheet,
  rowIndex: number,
  colCount: number,
): (number | null)[] {
  const row = ws.getRow(rowIndex);
  const out: (number | null)[] = [];
  for (let c = 1; c <= colCount; c++) out.push(cellNumber(row.getCell(c).value));
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// (2) Row-2 section-label pattern table
//
// TODO(§8.2, real-file finalization): only ONE label below is confirmed from a
// real file today; the rest are INFERRED from tab purpose (PR#87 §1.1) and MUST
// be reconciled against the actual row-2 strings when the June + July workbooks
// land on titan (rollup §7). Update the `confirmed` flags then; the code path is
// stable regardless of which labels prove exact.
//
//   CONFIRMED : inb_trans_charges  ("INBOUND WITH TRANS CHARGE - <site>")
//   INFERRED  : every other row-2 label pattern in this table
//
// Ordering matters: more-specific patterns MUST precede their supersets
// (trans_summary before summary; all_inbounds before summary). Patterns are kept
// narrow enough to never collide with a plain column-header word (a fixture whose
// row 2 IS the header row must fall through to header-signature / name matching).
// ────────────────────────────────────────────────────────────────────────

interface LabelRule {
  type: WorksheetSemanticType;
  pattern: RegExp;
  confirmed: boolean;
}

const ROW2_LABEL_RULES: readonly LabelRule[] = [
  { type: 'inb_trans_charges', pattern: /INBOUND\s+WITH\s+TRANS\s+CHARGE/i, confirmed: true },
  {
    type: 'inb_no_trans_charge',
    pattern: /INBOUND\s+(WITH\s+)?NO\s+TRANS\s+CHARGE/i,
    confirmed: false,
  },
  { type: 'incentive_unpaid', pattern: /\b(INCENTIVE|UNPAID)\b.*\bDROP\b/i, confirmed: false },
  { type: 'all_inbounds', pattern: /ALL\s+INBOUND/i, confirmed: false },
  { type: 'trans_summary', pattern: /TRANS(PORTATION)?\s+SUMMARY/i, confirmed: false },
  { type: 'container_rentals', pattern: /CONTAINER\s+RENTAL/i, confirmed: false },
  { type: 'renovation', pattern: /\bRENOVATION\b/i, confirmed: false },
  { type: 'processed', pattern: /\bPROCESSED\b/i, confirmed: false },
  { type: 'nonprogram', pattern: /NON.?PROGRAM/i, confirmed: false },
  { type: 'events', pattern: /\bEVENT/i, confirmed: false },
  // `summary` is the broadest — keep it LAST so trans_summary / all_inbounds win.
  {
    type: 'summary',
    pattern: /(MID-?MONTH|MONTH\s+RUNNING\s+TOTAL|\bSUMMARY\b)/i,
    confirmed: false,
  },
] as const;

/** Exposed for §8.2 reconciliation + tests: which labels are proven vs inferred. */
export const ROW2_LABEL_CONFIRMATIONS: ReadonlyMap<WorksheetSemanticType, boolean> = new Map(
  ROW2_LABEL_RULES.map((r) => [r.type, r.confirmed]),
);

// ────────────────────────────────────────────────────────────────────────
// (3) Header-row column-signature table
//
// Each signature lists the DISTINCTIVE normalized column names that must ALL be
// present in a candidate header row for the type to match. Only UNAMBIGUOUS
// signatures are registered: `inb_no_trans_charge` and `nonprogram` share an
// identical column set (PR#87 §1.1) and so are deliberately absent here — they
// are disambiguated by row-2 label or by the name fallback, never by signature.
// Column sets are drawn from the §5 fixtures' `columns` arrays + PR#87 §1.1.
// ────────────────────────────────────────────────────────────────────────

interface HeaderSignature {
  type: WorksheetSemanticType;
  required: readonly string[]; // normalized (lowercase, whitespace-collapsed)
}

const HEADER_SIGNATURES: readonly HeaderSignature[] = [
  // inb trans charges: uniquely carries the freight/fuel/total triad (fixture row 3).
  { type: 'inb_trans_charges', required: ['freight rate', 'fuel surcharge', 'total'] },
  // Fuel: EIA weekly price table (fixture row 2).
  { type: 'fuel', required: ['begin date', 'end date', 'price per gallon'] },
  // Commodities: outbound-by-commodity with material# + outbound unit# (distinct
  // from Renovation, which lacks "outbound unit #"). Check before renovation.
  { type: 'commodities', required: ['outbound unit #', 'material #'] },
  { type: 'renovation', required: ['sub category', 'material #'] },
  // Events tab (PR#87 §1.1).
  { type: 'events', required: ['customer', 'county', 'slip'] },
  // Container Rentals rate table (PR#87 §1.1).
  { type: 'container_rentals', required: ['trailer size', 'rental amount due'] },
  // variables master lookup — Re-Trac Random ID is its fingerprint (PR#87 §1.1/§3.5).
  { type: 'variables', required: ['re-trac random id'] },
] as const;

// ────────────────────────────────────────────────────────────────────────
// (4) Prefix-stripping name fallback
//
// Strip a leading month(+year) token, then exact-match the remainder against a
// table of known BASE names. Handles both spaced ("June26 Commodities") and
// glued ("June2026All") prefixes. Underscores are normalized to spaces so
// "incentive_unpaid" and "incentive unpaid" collapse to one key.
// ────────────────────────────────────────────────────────────────────────

const MONTH_PREFIX =
  /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s?\d{2,4}\s*/i;

function normalizeName(raw: string): string {
  return raw.replace(/_/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

const BASE_NAME_TYPES: ReadonlyMap<string, WorksheetSemanticType> = new Map([
  ['inb trans charges', 'inb_trans_charges'],
  ['inb no trans charge', 'inb_no_trans_charge'],
  ['incentive unpaid', 'incentive_unpaid'],
  ['nonprogram', 'nonprogram'],
  ['non program', 'nonprogram'],
  ['renovation', 'renovation'],
  ['commodities', 'commodities'],
  ['processed', 'processed'],
  ['container rentals', 'container_rentals'],
  ['trans summary', 'trans_summary'],
  ['summary', 'summary'],
  ['events', 'events'],
  ['all', 'all_inbounds'],
  ['variables', 'variables'],
  ['list', 'list'],
  ['fuel', 'fuel'],
]);

// ────────────────────────────────────────────────────────────────────────
// Resolution
// ────────────────────────────────────────────────────────────────────────

const DAY_SHEET_RE = /^DAY\d{1,2}$/i;

function normalizeCell(text: string | null): string | null {
  if (text === null) return null;
  const n = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return n || null;
}

function matchRow2Label(row2: (string | null)[]): WorksheetSemanticType | null {
  const joined = row2.filter((c): c is string => c !== null && c.trim() !== '').join(' ');
  if (!joined.trim()) return null;
  for (const rule of ROW2_LABEL_RULES) {
    if (rule.pattern.test(joined)) return rule.type;
  }
  return null;
}

function matchHeaderSignature(
  headerRows: Record<number, (string | null)[]>,
): WorksheetSemanticType | null {
  for (const cells of Object.values(headerRows)) {
    const present = new Set(cells.map(normalizeCell).filter((c): c is string => c !== null));
    for (const sig of HEADER_SIGNATURES) {
      if (sig.required.every((col) => present.has(col))) return sig.type;
    }
  }
  return null;
}

function matchNameFallback(name: string): WorksheetSemanticType | null {
  const stripped = name.replace(MONTH_PREFIX, '');
  const key = normalizeName(stripped);
  return BASE_NAME_TYPES.get(key) ?? null;
}

/**
 * Resolve a worksheet's semantic type from its name + row projections.
 *
 * Resolution order (documented in the module header):
 *   1. DAY sheets by name (`^DAY\d{1,2}$` — stable across all months)
 *   2. row-2 section-label pattern match
 *   3. header-row column-signature match
 *   4. prefix-stripped name fallback against known base names
 *   5. 'unknown' (never throws)
 */
export function resolveSectionType(input: ResolveInput): WorksheetSemanticType {
  // (1) DAY sheets — names are stable June↔July (both DAY0..DAY31).
  if (DAY_SHEET_RE.test(input.name.trim())) return 'day';

  // (2) row-2 section label (durable across month renames).
  if (input.row2) {
    const byLabel = matchRow2Label(input.row2);
    if (byLabel) return byLabel;
  }

  // (3) header-row column signature (unambiguous shapes only).
  if (input.headerRows) {
    const bySignature = matchHeaderSignature(input.headerRows);
    if (bySignature) return bySignature;
  }

  // (4) normalized-name fallback (strip month/year prefix, exact base-name match).
  const byName = matchNameFallback(input.name);
  if (byName) return byName;

  // (5) unrecognized — return, never throw.
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────────────
// exceljs entry point
// ────────────────────────────────────────────────────────────────────────

/** Candidate header rows probed per sheet (category tabs=3, NonProgram/Fuel=2, variables=1, DAY grid=51). */
const HEADER_ROW_CANDIDATES = [1, 2, 3, 51] as const;

/** Read a full row up to the sheet's widest defined column (min 12 for header signatures). */
function projectRow(ws: ExcelJS.Worksheet, rowIndex: number): (string | null)[] {
  const colCount = Math.max(ws.columnCount || 0, 12);
  return readSectionRow(ws, rowIndex, colCount);
}

/** Classify every worksheet in a loaded workbook into its `WorksheetSemanticType`. */
export function classifyWorkbookSheets(wb: ExcelJS.Workbook): Map<string, WorksheetSemanticType> {
  const out = new Map<string, WorksheetSemanticType>();
  for (const ws of wb.worksheets) {
    const row2 = projectRow(ws, 2);
    const headerRows: Record<number, (string | null)[]> = {};
    for (const r of HEADER_ROW_CANDIDATES) headerRows[r] = projectRow(ws, r);
    out.set(ws.name, resolveSectionType({ name: ws.name, row2, headerRows }));
  }
  return out;
}
