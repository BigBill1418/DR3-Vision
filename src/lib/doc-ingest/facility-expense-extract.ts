// ADR-0104 §D4 — the facility expense-log extractor.
//
// "Woodland Invoices tracking.xlsx" is a hand-kept desk log of expenses already
// paid. Per-sheet shape (the `commodity-extract.ts` shape), because these sheets
// are genuinely independent documents that happen to share a workbook — unlike
// the outbound file, whose sheets duplicate one another and therefore had to be
// read together.
//
// ── THE THING THE PLAN GOT WRONG, AND WHAT IS DONE INSTEAD ─────────────────
// The build plan mapped `Invoice Date` straight onto a date column. Measured
// against the live bytes 2026-08-15, that column DOES NOT HOLD DATES. It holds
// DAY-OF-MONTH numbers — 5, 6, 12, 27 — and the month lives in BANNER ROWS
// written into the sheet body ("February", "March"). Across the two Woodland
// sheets, ZERO of 332 rows carry a cell a date could be read from.
//
// So: `invoiceDateISO` is set only where the CELL ITSELF held a real date, and
// the two halves the sheet actually wrote are kept separately —
// `invoiceMonthLabel` (the forward-filled banner, verbatim) and `invoiceDay`
// (1–31). Composing them into a date here was rejected, twice over:
//   - 25 rows on WOODLAND 2026 and 15 on WOODLAND 2025 sit ABOVE the first
//     banner, so their month is genuinely unstated and "January" would be an
//     inference from position; and
//   - WOODLAND 2026 carries TWO blocks both bannered "July", so a composed date
//     would be confidently wrong for one of them.
// A composed date would be indistinguishable on screen from one the operator
// wrote, and a guess made first becomes the default by inertia (ADR-0080 §D7).
//
// ── Money-touching, so it stages ──────────────────────────────────────────
// $974,928.36 across the two Woodland sheets. Preview-then-confirm, per
// ADR-0069 Am.2's rule.
//
// Pure — no exceljs. Never throws for a refusing sheet; refusals are returned.

import { HEADER_SCAN_ROWS } from './header-detect';
import type { Cell } from './trailer-extract';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** Its presence is what makes a sheet an expense sheet at all. */
const ANCHOR_HEADER = 'Invoice Date';

export interface FacilityExpenseRow {
  /** 1-based row number in the sheet — provenance back to the source. */
  rowIndex: number;
  presentOnDailyLog: string | null;
  receiptRaw: string | null;
  /** Set ONLY when the cell itself held a real date. See the header. */
  invoiceDateISO: string | null;
  /** ALWAYS what the cell said ("5"). */
  invoiceDateRaw: string | null;
  /** The forward-filled banner above this row, verbatim. NULL above the first. */
  invoiceMonthLabel: string | null;
  /** 1–31 when the cell held a plain day number. */
  invoiceDay: number | null;
  /** NULL when the cell was blank. NEVER 0. */
  amount: number | null;
  creditAmount: number | null;
  categoryRaw: string | null;
  /** Trimmed + lower-cased, for grouping. A convenience, not a taxonomy. */
  categoryNorm: string | null;
  invoiceNumber: string | null;
  notes: string | null;
  machineIdRaw: string | null;
  dayRaw: string | null;
  commodityRaw: string | null;
  /** Set ONLY when `commodityRaw` matches ^H-?\d+. */
  haulRef: string | null;
  gallons: number | null;
}

export interface FacilityExpenseFailure {
  kind: 'no_header_row' | 'site_not_registered' | 'site_not_this_document' | 'no_rows';
  message: string;
}

export interface FacilityExpenseExtractResult {
  sheetName: string;
  /** From the sheet NAME ("WOODLAND 2026" -> 2026). NULL when unreadable. */
  sheetYear: number | null;
  headerRowIndex: number;
  headers: string[];
  rows: FacilityExpenseRow[];
  /** Rows recognised as month banners — skipped, and counted so they are visible. */
  bannerRows: number;
  /** `Monthly Total` / `Yearly Total` label rows. */
  subtotalRows: number;
  /** Header rows repeated mid-sheet at the top of each month block. */
  repeatedHeaderRows: number;
  totals: { amount: number; creditAmount: number };
  failure: FacilityExpenseFailure | null;
}

function norm(h: string): string {
  return h.replace(/\s+/g, ' ').trim().toLowerCase();
}

function text(c: Cell | null | undefined): string | null {
  const t = c?.text.trim() ?? '';
  return t === '' ? null : t;
}

function at(row: readonly Cell[], i: number): Cell | null {
  if (i < 0) return null;
  return row[i] ?? null;
}

/** A cost cell: blank is NOT RECORDED, never zero (the ADR-0069 Am.2 rule). */
function money(c: Cell | null): number | null {
  if (c === null || c.text.trim() === '') return null;
  return c.num ?? null;
}

/** "WOODLAND 2026" -> 2026. Read off the sheet name; never inferred. */
export function sheetYearOf(sheetName: string): number | null {
  const m = sheetName.match(/\b(20\d{2})\b/);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * The place word a sheet name leads with — "WOODLAND 2026" -> "woodland".
 *
 * Deliberately not a match against four hardcoded sheet names: a fifth sheet
 * arriving next year must be answered by the same rule, not by an edit.
 */
export function sheetSiteToken(sheetName: string): string | null {
  const m = sheetName.trim().match(/^([A-Za-z][A-Za-z\s.'-]*?)\s*\d{4}\s*$/);
  return m?.[1] ? norm(m[1]) : null;
}

/**
 * The place words a registered site answers to.
 *
 * `sites.name` is "DR3 Woodland"; the sheet is called "WOODLAND 2026". Both
 * readings are returned so the gate matches the sheet's own vocabulary without
 * either hardcoding sheet names or assuming the site prefix never changes.
 */
export function siteNameTokens(siteName: string): string[] {
  const full = norm(siteName);
  const last = full.split(' ').filter(Boolean).at(-1);
  return last !== undefined && last !== full ? [full, last] : [full];
}

export interface FacilityExpenseSiteScope {
  /**
   * Place tokens that have a row in `sites`, lower-cased ("woodland",
   * "eugene"). A sheet naming anything else is refused, because a NULL site must
   * never reach a site-scoped surface (hard rule #2).
   */
  registeredTokens: string[];
  /**
   * The tokens of the site THIS document is confirmed against. A sheet naming a
   * DIFFERENT registered site is refused rather than re-attributed.
   */
  documentTokens: string[];
}

/**
 * Extract expense rows from one sheet.
 *
 * `cells` is the whole sheet as a rectangular grid (row-major, 0-indexed). A
 * sheet that refuses does not sink the document — the same discipline as
 * `commodity-extract.ts`, and here it is load-bearing: two of the five sheets
 * are Stockton and are refused BY DESIGN.
 */
export function extractFacilityExpenseRows(
  sheetName: string,
  cells: Cell[][],
  scope: FacilityExpenseSiteScope,
): FacilityExpenseExtractResult {
  const sheetYear = sheetYearOf(sheetName);
  const base = {
    sheetName,
    sheetYear,
    headerRowIndex: 0,
    headers: [] as string[],
    rows: [] as FacilityExpenseRow[],
    bannerRows: 0,
    subtotalRows: 0,
    repeatedHeaderRows: 0,
    totals: { amount: 0, creditAmount: 0 },
  };

  // ── Site gate FIRST, before any reading ─────────────────────────────────
  // Stockton is not a row in `sites`. Absorbing its rows would put a NULL site
  // — or, worse, Woodland's — on $21,860 of somebody else's expenses.
  const token = sheetSiteToken(sheetName);
  if (token !== null) {
    if (!scope.registeredTokens.includes(token)) {
      return {
        ...base,
        failure: {
          kind: 'site_not_registered',
          message:
            `Sheet "${sheetName}" names "${token}", which has no row in \`sites\`. Its rows are ` +
            `REFUSED rather than absorbed under this document's site — a figure attributed to the ` +
            `wrong facility is worse than a figure nobody has.`,
        },
      };
    }
    if (scope.documentTokens.length > 0 && !scope.documentTokens.includes(token)) {
      return {
        ...base,
        failure: {
          kind: 'site_not_this_document',
          message:
            `Sheet "${sheetName}" names the registered site "${token}", but this document is ` +
            `confirmed against "${scope.documentTokens.join('"/"')}". Absorption is ` +
            `per-document-site, so this ` +
            `sheet is refused rather than re-attributed.`,
        },
      };
    }
  }

  // ── The header row, found by its anchor ─────────────────────────────────
  let headerRowIndex = 0;
  let headers: string[] = [];
  const scan = Math.min(HEADER_SCAN_ROWS, cells.length);
  for (let r = 0; r < scan; r += 1) {
    const row = cells[r];
    if (!row) continue;
    if (row.some((c) => norm(c.text) === norm(ANCHOR_HEADER))) {
      headerRowIndex = r + 1;
      headers = row.map((c) => c.text.trim());
      break;
    }
  }
  if (headerRowIndex === 0) {
    return {
      ...base,
      failure: {
        kind: 'no_header_row',
        message:
          `Sheet "${sheetName}" has no "${ANCHOR_HEADER}" column in its first ${HEADER_SCAN_ROWS} ` +
          `rows, so it is not an expense sheet.`,
      },
    };
  }

  const normed = headers.map(norm);
  const col = (label: string): number => normed.indexOf(norm(label));
  const dateCol = col(ANCHOR_HEADER);
  const amtCol = col('Amt.');
  const creditCol = col('credit amt');
  const catCol = col('category');
  const invNoCol = col('Invoice #');
  const notesCol = col('Notes');
  const machineCol = col('Machine ID');
  const dayCol = col('day');
  const commodityCol = col('commodity');
  const gallonsCol = col('gallons');
  const dailyLogCol = col('Present on Daily Log');
  // The receipt column is headed `desk receipt` on three sheets and
  // `receipt date` on STOCKTON 2025. Both, explicitly — not a regex that would
  // also swallow `Invoice Date`.
  const receiptCol = col('desk receipt') >= 0 ? col('desk receipt') : col('receipt date');

  const rows: FacilityExpenseRow[] = [];
  let bannerRows = 0;
  let subtotalRows = 0;
  let repeatedHeaderRows = 0;
  let monthLabel: string | null = null;

  for (let r = headerRowIndex; r < cells.length; r += 1) {
    const row = cells[r];
    if (!row) continue;
    if (row.every((c) => c.text.trim() === '')) continue;

    const amount = money(at(row, amtCol));
    const creditAmount = money(at(row, creditCol));
    const categoryRaw = text(at(row, catCol));
    const invoiceNumber = text(at(row, invNoCol));
    const dateCell = at(row, dateCol);
    const invoiceDateRaw = text(dateCell);

    // A `Monthly Total` / `Yearly Total` row is the sheet's own arithmetic, not
    // an expense. Absorbing it would double every month.
    if (row.some((c) => /^(monthly|yearly)\s+total/i.test(c.text.trim()))) {
      subtotalRows += 1;
      continue;
    }

    // The header repeats at the top of every month block. Checked on THREE
    // columns because STOCKTON 2025 has one repeat whose `category` cell is
    // blank — a single-column test would have let that row through as data.
    if (
      norm(categoryRaw ?? '') === 'category' ||
      norm(invoiceDateRaw ?? '') === norm(ANCHOR_HEADER) ||
      norm(text(at(row, amtCol)) ?? '') === 'amt.'
    ) {
      repeatedHeaderRows += 1;
      continue;
    }

    // A month BANNER: a row whose only content is a month name. WOODLAND 2025
    // writes one of these into the Invoice Date column rather than the usual
    // one, so the whole row is searched instead of a fixed cell.
    if (amount === null && creditAmount === null && categoryRaw === null && invoiceNumber === null) {
      const banner = row.map((c) => c.text.trim()).find((t) => MONTHS.includes(norm(t) as never));
      if (banner !== undefined) {
        monthLabel = banner;
        bannerRows += 1;
        continue;
      }
    }

    // An expense row states at least one of: when, how much, or what for.
    // Anything else is a vendor-name scribble in a margin cell.
    if (invoiceDateRaw === null && amount === null && categoryRaw === null) continue;

    const commodityRaw = text(at(row, commodityCol));
    const gallonsCell = at(row, gallonsCol);

    rows.push({
      rowIndex: r + 1,
      presentOnDailyLog: text(at(row, dailyLogCol)),
      receiptRaw: text(at(row, receiptCol)),
      invoiceDateISO: dateCell?.date ?? null,
      invoiceDateRaw,
      invoiceMonthLabel: monthLabel,
      invoiceDay:
        dateCell?.date === null &&
        dateCell?.num !== null &&
        dateCell?.num !== undefined &&
        Number.isInteger(dateCell.num) &&
        dateCell.num >= 1 &&
        dateCell.num <= 31
          ? dateCell.num
          : null,
      amount,
      creditAmount,
      categoryRaw,
      categoryNorm: categoryRaw === null ? null : norm(categoryRaw),
      invoiceNumber,
      notes: text(at(row, notesCol)),
      machineIdRaw: text(at(row, machineCol)),
      dayRaw: text(at(row, dayCol)),
      commodityRaw,
      // The column is overloaded — real commodities ("wood", "pocket coils") and
      // 6 H-haul references. Only the latter shape becomes a reference.
      haulRef: commodityRaw !== null && /^H-?\d+/i.test(commodityRaw) ? commodityRaw : null,
      gallons: money(gallonsCell),
    });
  }

  const totals = rows.reduce(
    (acc, x) => ({
      amount: acc.amount + (x.amount ?? 0),
      creditAmount: acc.creditAmount + (x.creditAmount ?? 0),
    }),
    { amount: 0, creditAmount: 0 },
  );

  if (rows.length === 0) {
    return {
      ...base,
      headerRowIndex,
      headers,
      bannerRows,
      subtotalRows,
      repeatedHeaderRows,
      failure: {
        kind: 'no_rows',
        message:
          `Sheet "${sheetName}" resolved its columns on row ${headerRowIndex} but produced no ` +
          `expense rows (${bannerRows} month banner(s), ${subtotalRows} subtotal row(s), ` +
          `${repeatedHeaderRows} repeated header row(s) were recognised and skipped).`,
      },
    };
  }

  return {
    sheetName,
    sheetYear,
    headerRowIndex,
    headers,
    rows,
    bannerRows,
    subtotalRows,
    repeatedHeaderRows,
    totals,
    failure: null,
  };
}
