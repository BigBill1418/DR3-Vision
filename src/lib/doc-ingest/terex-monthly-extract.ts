// ADR-0081 — the TEREX workbook's MONTHLY OPERATING tabs, extracted.
//
// ADR-0069 Am.2 deliberately left these 38 sheets alone and absorbed only the
// two maintenance logs. That decision was right for its purpose (money) and its
// stated reason was that the monthly tabs "carry processed units per day, which
// is `processed_units_daily` territory". ADR-0079 changed the ground under that
// sentence: the machine's units and RUN HOURS now have their own table
// (`equipment_daily_throughput`), which is not `processed_units_daily` and has
// no precedence rule to break. These tabs are that table's history.
//
// Bill's directive, verbatim: "use the excel sheet to pull in the historical
// data - then STARTING TODAY you will just take in the data that JT enters here
// but ALL OF THAT DATA needs to be aggregated and displayed IN THIS PAGE."
//
// ── The five hazards this file exists to survive ────────────────────────────
//
// 1. THERE IS NO DATE COLUMN. Not one of the 24 monthly tabs has a header that
//    says "Date". The day is carried in an UNLABELED leading cell (column A) as
//    a bare day-of-month, and the MONTH and YEAR live in two cells of the title
//    row (`Terex Operating Data | July | 2026`). Deriving the date from the row
//    ORDINAL instead is the single most attractive shortcut here and it is
//    wrong: it silently survives every tab that happens to start on row 3 with
//    day 1, and then mis-dates every row after the first inserted or deleted
//    line. `import.date-never-ordinal` inserts a row mid-month and proves the dates
//    downstream do not move.
//
// 2. THREE DECOY TABS wear the full canonical header shape: `Aug25(1)`,
//    `Template` and `Template (2)`. Header-shape matching — the technique
//    `terex-extract.ts` correctly uses for the maintenance logs — CANNOT tell
//    them from a real month, because their headers are byte-identical to a real
//    month's. `Aug25(1)` is the dangerous one: it is a half-finished draft
//    carrying real-looking operator notes, an instructional `Example` row, and
//    end-hour readings written into the DAY-HOURS column, which totals
//    3,683.95 hours in a month that has 744. So tab selection here is an
//    EXPLICIT ALLOWLIST of 24 names, cross-checked against the month and year
//    the tab's own title row claims — and all three decoys say `MONTH`/`YEAR`
//    literally, so they fail the cross-check as well as the allowlist.
//
// 3. THE 2024 TABS ARE FOUR BESPOKE SCHEMAS. `Sept24` puts its header on row 1
//    with `Date | Processed | Received | Hrs Used`; `Oct24` has a doubled
//    per-commodity layout with THREE separate `Hrs Used` columns; `Nov24` and
//    `Dec24` are two more shapes again, one of them carrying `Start Time`/`End
//    Time` clock times rather than hour-meter readings. They are out of v1 and
//    filed as an open item. Writing one extractor that "handles" four schemas
//    it was never measured against is how a wrong number gets a confident
//    label.
//
// 4. UNITS ARE THREE COLUMNS. `Pocket coil` + `Springs` + `Wood`, summed. Any
//    one of them alone under-reports; the workbook's own totals row sums all
//    three separately and the reconciliation compares against their sum.
//
// 5. ROW COUNTS VARY 36–102 and the data block is not the sheet. Below the days
//    sit a totals row, a `*Key` legend (`G` / `PS` / `LOTO`), and on some tabs
//    further analysis blocks. The data block is bounded by the day cells
//    themselves, never by a row count.
//
// ── What this file is NOT allowed to do ─────────────────────────────────────
// Nothing here coerces. A row whose hours cell is blank, zero or unreadable is
// SKIPPED and COUNTED — never defaulted to 8, never inferred from
// `End Hours - Start Hours` (that difference is exactly what the sheet's own
// formula already computes, and re-deriving it would quietly manufacture hours
// on the rows where the operator left the formula un-filled on purpose).
//
// Pure: no exceljs, no Prisma, no clock. `Cell[][]` in, rows and outcomes out.

import type { Cell } from './trailer-extract';

/** Columns scanned per row. The monthly tabs use 12; the widest is 13. */
export const MONTHLY_MAX_COLS = 16;

/** Rows scanned below the header before giving up on finding the data block. */
const MAX_DATA_SCAN_ROWS = 48;

/**
 * ADR-0081 R5 sanity floor — a single day cannot exceed this many units.
 *
 * Deliberately STRICTER than `MAX_UNITS_PROCESSED` (10,000) in
 * `daily-throughput.ts`. That constant is a typo-catch on a human typing into a
 * form and has to tolerate a manager's worst plausible day. This one guards a
 * MACHINE reading a spreadsheet nobody is watching, where a mis-resolved column
 * can put an hour-meter reading (58,496) or a monthly total into a day's units
 * field. The real machine's best day in this workbook is 646.
 */
export const IMPORT_MAX_UNITS_PER_DAY = 5_000;

/** A calendar day has 24 hours. A row claiming more is a mis-read column. */
export const IMPORT_MAX_RUN_HOURS = 24;

/**
 * ADR-0081 R5 — the reconciliation tolerance, and the floor beneath it.
 *
 * `0.5%` relative, with an absolute floor of half a hundredth so that float
 * noise cannot fail a month. The hours cells are Excel formula results and
 * arrive as `7.849999999999909`, not `7.85`; `run_hours` is `Decimal(5,2)`, so
 * anything below 0.005 is beneath the recorded scale and cannot represent a
 * real discrepancy.
 */
export const RECONCILE_REL_TOLERANCE = 0.005;
export const RECONCILE_ABS_FLOOR = 0.005;

/**
 * ADR-0081 R2 — the 24 tabs, named explicitly, each with the month it MUST
 * turn out to be.
 *
 * An allowlist rather than a pattern, because every pattern that admits the 24
 * real tabs also admits `Aug25(1)`. The `expected` half is not redundant with
 * the name: it is what the tab's own title row is checked AGAINST, so a tab
 * renamed or re-purposed upstream fails loudly instead of importing a month's
 * data onto the wrong month. `Jan 2026` carries a space and `July25`/`March25`
 * spell the month out — the names are copied from the live workbook, not
 * generated, because they are not systematic.
 */
export const MONTHLY_TABS: ReadonlyArray<{ name: string; year: number; month: number }> = [
  { name: 'Jan25', year: 2025, month: 1 },
  { name: 'Feb25', year: 2025, month: 2 },
  { name: 'March25', year: 2025, month: 3 },
  { name: 'Apr25', year: 2025, month: 4 },
  { name: 'May25', year: 2025, month: 5 },
  { name: 'Jun25', year: 2025, month: 6 },
  { name: 'July25', year: 2025, month: 7 },
  { name: 'Aug25', year: 2025, month: 8 },
  { name: 'Sept25', year: 2025, month: 9 },
  { name: 'Oct25', year: 2025, month: 10 },
  { name: 'Nov25', year: 2025, month: 11 },
  { name: 'Dec25', year: 2025, month: 12 },
  { name: 'Jan 2026', year: 2026, month: 1 },
  { name: 'Feb26', year: 2026, month: 2 },
  { name: 'March26', year: 2026, month: 3 },
  { name: 'Apr26', year: 2026, month: 4 },
  { name: 'May26', year: 2026, month: 5 },
  { name: 'Jun26', year: 2026, month: 6 },
  { name: 'Jul26', year: 2026, month: 7 },
  { name: 'Aug26', year: 2026, month: 8 },
  { name: 'Sept26', year: 2026, month: 9 },
  { name: 'Oct26', year: 2026, month: 10 },
  { name: 'Nov26', year: 2026, month: 11 },
  { name: 'Dec26', year: 2026, month: 12 },
];

/**
 * ADR-0081 R3 — the 2024 tabs, named so they are EXCLUDED KNOWINGLY.
 *
 * Listing them separately from "everything else that is not on the allowlist"
 * is the difference between a decision and an oversight: the import report says
 * "out of scope for v1 (four bespoke 2024 schemas — OPEN-ITEMS)" for these,
 * and "not a monthly operating tab" for `diesel`. A reader of the report can
 * tell that somebody looked.
 */
export const TABS_2024_OUT_OF_SCOPE: ReadonlySet<string> = new Set([
  'Sept24',
  'Oct24',
  'Nov24',
  'Dec24',
]);

/** Why a whole TAB contributed nothing. */
export type TabSkipReason =
  /** Not on the 24-name allowlist and not a known 2024 tab. */
  | 'not_a_monthly_tab'
  /** ADR-0081 R3 — one of the four 2024 schemas. Deliberate, not accidental. */
  | 'out_of_scope_2024'
  /** On the allowlist, but its title row does not claim the month it should. */
  | 'title_month_mismatch'
  /** The canonical header row could not be resolved. */
  | 'header_not_resolved'
  /** No row carried a usable day-of-month cell. */
  | 'no_day_rows'
  /** ADR-0081 R1 — more than 10% of day rows failed to resolve. */
  | 'too_many_failed_rows';

/** Why ONE row contributed nothing. Every one of these is counted and reported. */
export type RowSkipReason =
  /** The leading cell held no day-of-month number. */
  | 'no_day_cell'
  /** A day number that does not exist in this tab's month (e.g. Feb 30). */
  | 'day_out_of_month'
  /** A second row claiming a day an earlier row already claimed. */
  | 'duplicate_day'
  /** Blank / zero / unreadable hours. NEVER coerced — ADR-0079's NOT NULL > 0. */
  | 'no_run_hours'
  /** Hours beyond the 24 a day has: a mis-read column, not a long shift. */
  | 'run_hours_insane'
  /** Units beyond the sanity floor, or negative. */
  | 'units_insane'
  /**
   * A fractional unit count against an INTEGER column.
   *
   * `March25` day 29 reads `131.75` pocket coils — the only such cell in the
   * workbook. `units_processed` is `INTEGER NOT NULL`, so this row cannot be
   * stored as written, and every way of storing it anyway is a lie: `132`
   * invents a quarter of a mattress, `131` discards one, and either one puts a
   * number nobody wrote into a table whose whole premise is that the figures
   * are the operator's own. Skipped, counted, and named in the report so a
   * manager can enter the day deliberately.
   */
  | 'units_not_integer';

export interface MonthlyDayRow {
  tabName: string;
  /** 1-based row number in the sheet — provenance back to the source cell. */
  rowIndex: number;
  /** `YYYY-MM-DD`, composed from the day CELL and the tab's verified month. */
  dateISO: string;
  pocketCoil: number;
  springs: number;
  wood: number;
  /** ADR-0081 hazard 4 — the three commodity columns, summed. */
  unitsTotal: number;
  /** The sheet's own `Day Total Hrs Used` — hours the machine RAN. */
  runHours: number;
  /** Hour-meter readings, carried for the report only. Never used to derive hours. */
  startHours: number | null;
  endHours: number | null;
  operator: string | null;
  condition: string | null;
  notes: string | null;
}

export interface RowSkip {
  rowIndex: number;
  reason: RowSkipReason;
  /** What the cells actually said, so a skip can be argued with. */
  detail: string;
}

/** ADR-0081 R5 — one comparison against a figure the WORKBOOK published. */
export interface ReconcileCheck {
  label: string;
  /** What this extractor computed. */
  extracted: number;
  /** What the workbook's own cell says. NULL when the workbook published none. */
  published: number | null;
  /** `published - extracted`. NULL when there is nothing to compare. */
  delta: number | null;
  /** Relative delta against `published`. NULL when uncomparable. */
  relative: number | null;
  ok: boolean;
  /**
   * Advisory checks are REPORTED but never stage the import. The OVERVIEW tabs
   * contain at least one provably wrong formula (`OVERVIEW2026` row 12 computes
   * July's "High" units/hour with `MINIFS`), so making every published cell a
   * hard gate would let the workbook's own bug block a correct import.
   */
  advisory: boolean;
}

export interface MonthlyTabOutcome {
  name: string;
  expected: { year: number; month: number } | null;
  status: 'extracted' | 'skipped';
  skipReason: TabSkipReason | null;
  /** What the title row claimed, verbatim — `MONTH`/`YEAR` on the decoys. */
  titleMonthRaw: string | null;
  titleYearRaw: string | null;
  headerRowIndex: number;
  /** The row the workbook keeps its own SUMs on, when one was found. */
  totalsRowIndex: number | null;
  /** Rows whose leading cell held a day number — the denominator for R1's 10%. */
  dayRowsSeen: number;
  rowsExtracted: number;
  skips: RowSkip[];
  /** Σ over every day row READ, including ones later held back for no hours. */
  parsedUnits: number;
  parsedHours: number;
  reconciliation: ReconcileCheck[];
  /** True when every NON-advisory check passed. */
  reconciled: boolean;
  /**
   * ADR-0081 R5 — day rows this tab carries that its OWN totals formula does not
   * add up. A defect in the SOURCE DOCUMENT, not in the import: reported loudly,
   * never blocking, because the rows are read correctly and the only thing wrong
   * is the workbook's published summary of them.
   */
  coverageGap: {
    rowIndex: number;
    dateISO: string;
    units: number;
    hours: number | null;
    /** Which formula's declared range fails to reach this row. */
    missingFrom: ('units' | 'hours')[];
  }[];
}

export interface MonthlyExtractResult {
  rows: MonthlyDayRow[];
  tabs: MonthlyTabOutcome[];
  /** Allowlisted tabs whose reconciliation failed. Non-empty ⇒ R5 hard stop. */
  offendingTabs: string[];
  /** True when nothing may be applied. ADR-0081 R5. */
  hardStop: boolean;
}

const MONTH_NAMES = [
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
];

/**
 * `"SEPT"` → 9. Prefix matching, because the workbook writes the same month as
 * `January`, `JAN`, `Sept` and `SEPTEMBER` across different tabs.
 *
 * Returns null for anything that is not a month — including the literal
 * `MONTH` the three decoy tabs carry, which is the point.
 */
export function parseMonthName(raw: string | null): number | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase().replace(/\.$/, '');
  if (s === '') return null;
  // `may` is both a full name and a prefix of nothing else; `mar` matches march
  // only. An ambiguous prefix (`ju` → june/july) is refused rather than guessed.
  const hits = MONTH_NAMES.map((m, i) => (m.startsWith(s) ? i + 1 : 0)).filter((i) => i > 0);
  return hits.length === 1 ? hits[0]! : null;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cellAt(row: readonly Cell[] | undefined, i: number): Cell | null {
  if (!row || i < 0) return null;
  return row[i] ?? null;
}

/** A number cell, or null. Blank is NULL — never 0 (ADR-0077 D4). */
function numOf(c: Cell | null): number | null {
  if (c === null || c.text.trim() === '') return null;
  return typeof c.num === 'number' && Number.isFinite(c.num) ? c.num : null;
}

/** A commodity cell. Blank counts as 0 UNITS because the sheet's SUM does. */
function unitsOf(c: Cell | null): number {
  const n = numOf(c);
  return n == null ? 0 : n;
}

function textOf(c: Cell | null): string | null {
  const t = c?.text.trim() ?? '';
  return t === '' ? null : t;
}

export interface MonthlyColumns {
  /** 0-based. The UNLABELED leading column that carries the day-of-month. */
  day: number;
  pocketCoil: number;
  springs: number;
  wood: number;
  startHours: number;
  endHours: number;
  runHours: number;
  operator: number;
  condition: number;
  notes: number;
}

/**
 * Resolve the canonical columns from the header ROW ITSELF, by label.
 *
 * NOT from a `headers[]` array. `detectHeaderRow` drops leading blanks when it
 * normalizes, and the day column's header IS blank — so a headers array puts
 * `Pocket coil` at index 0 when it physically sits in column B, and every
 * column resolved from it lands one to the left. The day column would resolve
 * onto Pocket Coil and the units onto the hour meter. Reading the raw row keeps
 * physical position and label together.
 *
 * Matching is by REGEX on the label, never by fixed index: `Feb26` names its
 * hours column `Day Total Hrs Used (max hours 10)` and inserts a `re-fuel`
 * column before `Notes`, and the 2025 tabs carry one, two or three different
 * per-commodity rate columns between the hours and the operator. Columns A–G
 * happen to be identical across all 24 tabs today; resolving by label rather
 * than relying on that is what keeps next month's inserted column from silently
 * shifting the import.
 */
export function resolveMonthlyColumns(headerRow: readonly Cell[]): MonthlyColumns | null {
  const labels = headerRow.map((c) => norm(c?.text ?? ''));
  const find = (re: RegExp): number => labels.findIndex((l) => re.test(l));

  const pocketCoil = find(/^pocket ?coil/);
  const springs = find(/^springs$/);
  const wood = find(/^wood$/);
  const startHours = find(/^start hours/);
  const endHours = find(/^end hours/);
  // Anchored on "day total" so it can never match `Start Hours`, `End Hours`,
  // or the 2024 tabs' bare `Hrs Used`.
  const runHours = find(/^day total hrs used/);

  // Every one of these six must be present. A tab missing any of them is not
  // the canonical monthly layout and must not be read as though it were.
  if (pocketCoil < 0 || springs < 0 || wood < 0 || startHours < 0 || endHours < 0 || runHours < 0) {
    return null;
  }

  // The day column is the unlabeled one immediately LEFT of Pocket Coil. It is
  // identified by position relative to a resolved label rather than as "column
  // A", so the whole block can shift right without breaking.
  const day = pocketCoil - 1;
  if (day < 0) return null;

  return {
    day,
    pocketCoil,
    springs,
    wood,
    startHours,
    endHours,
    runHours,
    operator: find(/^operator/),
    condition: find(/^condition/),
    notes: find(/^notes/),
  };
}

/** Days in a month, so a `31` on a 30-day tab is refused rather than rolled over. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * ADR-0081 R1 — this row's day-of-month, from a CELL, or null.
 *
 * Accepts a whole number 1–31 (what all 24 tabs carry) and a genuine date cell
 * (defensive: none of the tabs use one today, but if a future month is typed
 * with real dates the day must come from the date, not from the fact that the
 * cell is unparseable as an integer).
 *
 * It is NOT given the row's position and cannot fall back to one. That is the
 * whole design: there is no code path here through which an ordinal can become
 * a date.
 */
export function dayOfMonthFromCell(c: Cell | null): number | null {
  if (c === null) return null;
  if (c.date !== null) {
    const d = Number(c.date.slice(8, 10));
    return Number.isInteger(d) && d >= 1 && d <= 31 ? d : null;
  }
  const n = c.num;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 31) return n;
  // A day typed as text (`"14"`). Anything else — `"Example"`, `"Monthly
  // Totals"`, `"G"` — is not a day and must not become one.
  const t = c.text.trim();
  if (/^\d{1,2}$/.test(t)) {
    const d = Number(t);
    return d >= 1 && d <= 31 ? d : null;
  }
  return null;
}

function relOk(extracted: number, published: number): boolean {
  const diff = Math.abs(published - extracted);
  return diff <= Math.max(Math.abs(published) * RECONCILE_REL_TOLERANCE, RECONCILE_ABS_FLOOR);
}

function check(
  label: string,
  extracted: number,
  published: number | null,
  advisory = false,
): ReconcileCheck {
  if (published === null) {
    return { label, extracted, published: null, delta: null, relative: null, ok: true, advisory };
  }
  const delta = published - extracted;
  const relative = published === 0 ? (extracted === 0 ? 0 : 1) : delta / published;
  return {
    label,
    extracted,
    published,
    delta,
    relative,
    ok: relOk(extracted, published),
    advisory,
  };
}

/**
 * Published figures for one month, read out of the workbook's own cells.
 * Supplied by the caller because gathering them needs the OVERVIEW tabs, which
 * this pure function is not given.
 */
export interface PublishedTotals {
  /** The tab's own totals row: Σ(Pocket coil) + Σ(Springs) + Σ(Wood). */
  units: number | null;
  /** The tab's own totals row: Σ(Day Total Hrs Used). */
  hours: number | null;
  /**
   * ADR-0081 R5 — the row range the units SUM formula actually DECLARES
   * (`SUM(B3:B30)` ⇒ `{3, 30}`), 1-based and inclusive.
   *
   * This exists because two of the 24 tabs total a SHORTER range than their own
   * data block, and reconciling against the bare cached figure mistook the
   * workbook's arithmetic bug for an extraction bug:
   *
   *   `March25` totals `SUM(B3:B30)` / `SUM(C3:C30)` — omitting day 29 (row 31,
   *   131.75 coils) and day 31 (row 33, 157 coils). Its HOURS formula covers the
   *   full `G3:G33`, which is why hours reconciled to the cent and units were
   *   out by exactly 288.75.
   *
   *   `Dec25` totals `SUM(B3:B32)` and `SUM(G3:G32)` — both omitting day 31 (row
   *   33, 182 coils and 7.45 hours). 1675 + 182 = 1857 and 67.99 + 7.45 = 75.44,
   *   which is exactly what this extractor read.
   *
   * Comparing over the DECLARED range is the true like-for-like question — "did
   * I read the same rows the same way Excel did?" — and it is strictly stronger
   * than the whole-tab compare, because it removes a confound without removing
   * a check: a cell mis-read INSIDE the range still fails, and the rows outside
   * it are reported separately as `coverageGap` rather than silently dropped.
   *
   * The alternative — widening the ±0.5% tolerance until both tabs passed —
   * would have needed ~19%, which is not a tolerance but a blindfold.
   */
  unitsRange: { firstRow: number; lastRow: number } | null;
  /** The row range the hours SUM formula declares. Same reasoning. */
  hoursRange: { firstRow: number; lastRow: number } | null;
  /**
   * The same hours figure, reached through an OVERVIEW cell that REFERENCES the
   * monthly tab's totals cell (`='Jan 2026'!G34`).
   *
   * This is not an independent measurement — the OVERVIEW is derived from the
   * monthly tabs, so by construction it is the same number. What it pins
   * independently is WHICH CELL the workbook itself calls the month's total,
   * which is exactly the thing a totals-row resolution can get wrong.
   */
  overviewHours: number | null;
  /** OVERVIEW's `AVERAGEIFS(B3:B33, ">0")` — a check on the ROW BOUNDS. */
  overviewAvgPocketCoil: number | null;
}

/**
 * Extract every allowlisted monthly tab.
 *
 * `sheets` is the whole workbook: this function decides what to read, so that
 * the decoy-exclusion decision lives in ONE place and is visible in the report
 * for every tab, including the ones it refused.
 */
export function extractMonthlyRows(
  sheets: ReadonlyArray<{ name: string; cells: Cell[][] }>,
  published: ReadonlyMap<string, PublishedTotals> = new Map(),
): MonthlyExtractResult {
  const allow = new Map(MONTHLY_TABS.map((t) => [t.name, t]));
  const rows: MonthlyDayRow[] = [];
  const tabs: MonthlyTabOutcome[] = [];

  for (const sheet of sheets) {
    const expect = allow.get(sheet.name);

    if (!expect) {
      tabs.push(
        blankOutcome(
          sheet.name,
          null,
          TABS_2024_OUT_OF_SCOPE.has(sheet.name) ? 'out_of_scope_2024' : 'not_a_monthly_tab',
        ),
      );
      continue;
    }

    const outcome = extractOneTab(sheet, expect, published.get(sheet.name) ?? null);
    tabs.push(outcome.outcome);
    if (outcome.outcome.status === 'extracted') rows.push(...outcome.rows);
  }

  const offendingTabs = tabs
    .filter((t) => t.status === 'extracted' && !t.reconciled)
    .map((t) => t.name);

  return { rows, tabs, offendingTabs, hardStop: offendingTabs.length > 0 };
}

function blankOutcome(
  name: string,
  expected: { year: number; month: number } | null,
  reason: TabSkipReason,
): MonthlyTabOutcome {
  return {
    name,
    expected,
    status: 'skipped',
    skipReason: reason,
    titleMonthRaw: null,
    titleYearRaw: null,
    headerRowIndex: 0,
    totalsRowIndex: null,
    dayRowsSeen: 0,
    rowsExtracted: 0,
    skips: [],
    parsedUnits: 0,
    parsedHours: 0,
    reconciliation: [],
    reconciled: true,
    coverageGap: [],
  };
}

/**
 * Find the header row by looking for the canonical column labels, within the
 * first few rows. Deliberately NOT `detectHeaderRow`: that returns a normalized
 * `headers[]` with leading blanks dropped, and this extractor needs the raw row
 * so that physical column positions survive (see `resolveMonthlyColumns`).
 */
function findHeaderRow(cells: readonly Cell[][]): { index: number; cols: MonthlyColumns } | null {
  for (let r = 0; r < Math.min(cells.length, 8); r += 1) {
    const row = cells[r];
    if (!row) continue;
    const cols = resolveMonthlyColumns(row);
    if (cols) return { index: r, cols };
  }
  return null;
}

function extractOneTab(
  sheet: { name: string; cells: Cell[][] },
  expect: { name: string; year: number; month: number },
  published: PublishedTotals | null,
): { outcome: MonthlyTabOutcome; rows: MonthlyDayRow[] } {
  const expected = { year: expect.year, month: expect.month };
  const header = findHeaderRow(sheet.cells);
  if (!header) {
    return {
      outcome: blankOutcome(sheet.name, expected, 'header_not_resolved'),
      rows: [],
    };
  }
  const cols = header.cols;

  // ── The title-row cross-check (ADR-0081 R2) ────────────────────────────────
  // The month and year are scanned across the rows ABOVE the header rather than
  // read from fixed cells, because the title row is row 1 on every tab today but
  // that is an observation, not a contract. All three decoys carry the literal
  // `MONTH` and `YEAR` placeholders, so they fail this even if the allowlist
  // were ever loosened.
  let titleMonthRaw: string | null = null;
  let titleYearRaw: string | null = null;
  let titleMonth: number | null = null;
  let titleYear: number | null = null;
  for (let r = 0; r < header.index; r += 1) {
    for (const c of sheet.cells[r] ?? []) {
      const t = textOf(c);
      if (t === null) continue;
      if (titleMonth === null) {
        const m = parseMonthName(t);
        if (m !== null) {
          titleMonth = m;
          titleMonthRaw = t;
          continue;
        }
      }
      if (titleYear === null && /^(19|20)\d{2}$/.test(t)) {
        titleYear = Number(t);
        titleYearRaw = t;
      }
    }
  }

  if (titleMonth !== expect.month || titleYear !== expect.year) {
    const out = blankOutcome(sheet.name, expected, 'title_month_mismatch');
    out.titleMonthRaw = titleMonthRaw;
    out.titleYearRaw = titleYearRaw;
    out.headerRowIndex = header.index + 1;
    return { outcome: out, rows: [] };
  }

  // ── The data block ────────────────────────────────────────────────────────
  // Bounded by the DAY CELLS, never by a row count (hazard 5). Scanning stops at
  // the first non-day row AFTER at least one day row — which lands exactly on the
  // totals row and therefore never walks into the `*Key` legend below it, nor
  // into the extra analysis blocks some 2025 tabs carry as far as row 100+.
  //
  // A non-day row BEFORE the first day row does not stop the scan: `Aug25(1)`
  // opens with an instructional `Example` row, and a real tab could acquire one.
  const dayLimit = daysInMonth(expect.year, expect.month);
  const skips: RowSkip[] = [];
  const claimed = new Map<number, number>(); // day -> row that claimed it
  const out: MonthlyDayRow[] = [];
  /**
   * Every day row's figures, keyed by its 1-based sheet row, recorded BEFORE any
   * skip decision. The reconciliation sums these over the workbook's own
   * declared SUM range, so it measures THE READING OF THE SHEET and never the
   * subset that survived the importability filter — a post-filter comparison
   * would be this file grading its own skip rule and would report green for
   * having skipped everything.
   */
  const perRow: { rowIndex: number; units: number; hours: number | null; dateISO: string }[] = [];
  let dayRowsSeen = 0;
  let totalsRowIndex: number | null = null;
  let started = false;

  const end = Math.min(sheet.cells.length, header.index + 1 + MAX_DATA_SCAN_ROWS);
  for (let r = header.index + 1; r < end; r += 1) {
    const row = sheet.cells[r];
    if (!row) continue;
    const day = dayOfMonthFromCell(cellAt(row, cols.day));

    if (day === null) {
      if (started) {
        totalsRowIndex = r + 1;
        break;
      }
      continue;
    }
    started = true;
    dayRowsSeen += 1;

    const rowIndex = r + 1;
    const pocketCoil = unitsOf(cellAt(row, cols.pocketCoil));
    const springs = unitsOf(cellAt(row, cols.springs));
    const wood = unitsOf(cellAt(row, cols.wood));
    const unitsTotal = pocketCoil + springs + wood;
    const hoursCell = numOf(cellAt(row, cols.runHours));

    // Recorded BEFORE any skip decision — see `perRow`.
    perRow.push({
      rowIndex,
      units: unitsTotal,
      hours: hoursCell,
      dateISO: day <= dayLimit ? iso(expect.year, expect.month, day) : `day-${day}`,
    });

    if (day > dayLimit) {
      skips.push({
        rowIndex,
        reason: 'day_out_of_month',
        detail: `day ${day} does not exist in ${expect.year}-${String(expect.month).padStart(2, '0')}`,
      });
      continue;
    }
    const prior = claimed.get(day);
    if (prior !== undefined) {
      skips.push({
        rowIndex,
        reason: 'duplicate_day',
        detail: `day ${day} already claimed by row ${prior}`,
      });
      continue;
    }
    claimed.set(day, rowIndex);

    // ADR-0079's `run_hours` is NOT NULL and CHECK (> 0). A blank, a zero or an
    // un-cached formula is NOT a day the machine ran — it is a day with no
    // measurement, and the honest representation of that is the ABSENCE of a
    // row (ADR-0077 D4). Nothing here defaults, and nothing derives the hours
    // from `End Hours - Start Hours`: that subtraction is precisely what the
    // sheet's own formula computes, so re-deriving it would manufacture hours
    // on exactly the rows where the operator left it blank on purpose.
    if (hoursCell === null || hoursCell <= 0) {
      skips.push({
        rowIndex,
        reason: 'no_run_hours',
        detail:
          `day ${day}: hours cell reads ${JSON.stringify(cellAt(row, cols.runHours)?.text ?? '')}` +
          `${unitsTotal > 0 ? ` (carrying ${unitsTotal} units, held back)` : ''}`,
      });
      continue;
    }
    if (hoursCell > IMPORT_MAX_RUN_HOURS) {
      skips.push({
        rowIndex,
        reason: 'run_hours_insane',
        detail: `day ${day}: ${hoursCell} hours exceeds the ${IMPORT_MAX_RUN_HOURS} a day has`,
      });
      continue;
    }
    if (unitsTotal < 0 || unitsTotal > IMPORT_MAX_UNITS_PER_DAY) {
      skips.push({
        rowIndex,
        reason: 'units_insane',
        detail: `day ${day}: ${unitsTotal} units is outside 0..${IMPORT_MAX_UNITS_PER_DAY}`,
      });
      continue;
    }
    // `units_processed` is INTEGER. Coercing is not available to us here — see
    // `units_not_integer`. One row in the live workbook trips this.
    if (!Number.isInteger(unitsTotal)) {
      skips.push({
        rowIndex,
        reason: 'units_not_integer',
        detail:
          `day ${day}: ${unitsTotal} units is fractional ` +
          `(pocket coil ${pocketCoil}, springs ${springs}, wood ${wood}) and the column is an integer`,
      });
      continue;
    }

    out.push({
      tabName: sheet.name,
      rowIndex,
      // THE DATE. Composed from the day CELL and the month the title row was
      // verified to claim. `r` is not in this expression and cannot be.
      dateISO: iso(expect.year, expect.month, day),
      pocketCoil,
      springs,
      wood,
      unitsTotal,
      runHours: hoursCell,
      startHours: numOf(cellAt(row, cols.startHours)),
      endHours: numOf(cellAt(row, cols.endHours)),
      operator: textOf(cellAt(row, cols.operator)),
      condition: textOf(cellAt(row, cols.condition)),
      notes: textOf(cellAt(row, cols.notes)),
    });
  }

  if (dayRowsSeen === 0) {
    const o = blankOutcome(sheet.name, expected, 'no_day_rows');
    o.titleMonthRaw = titleMonthRaw;
    o.titleYearRaw = titleYearRaw;
    o.headerRowIndex = header.index + 1;
    return { outcome: o, rows: [] };
  }

  // ── ADR-0081 R1 — the 10% failed-row ceiling ──────────────────────────────
  // Counts only the failures that mean "this row could not be RESOLVED"
  // (unreadable day, out of month, duplicate). `no_run_hours` is NOT a failure:
  // it is the normal shape of a weekend on a tab that pre-prints all 31 days,
  // and on a quiet month it is the majority of rows. Folding it in would fail
  // every correct tab.
  const unresolvable = skips.filter(
    (s) =>
      s.reason === 'no_day_cell' ||
      s.reason === 'day_out_of_month' ||
      s.reason === 'duplicate_day' ||
      s.reason === 'run_hours_insane' ||
      s.reason === 'units_insane' ||
      s.reason === 'units_not_integer',
  ).length;

  const parsedUnits = perRow.reduce((s, r) => s + r.units, 0);
  const parsedHours = perRow.reduce((s, r) => s + (r.hours ?? 0), 0);

  // ── ADR-0081 R5 — sum over the range the workbook's own formula DECLARES ───
  // Falls back to every day row when the caller could not read a range, so a
  // workbook whose totals are typed constants rather than formulas still gets a
  // real comparison rather than a silent pass.
  const inRange = (range: { firstRow: number; lastRow: number } | null | undefined) =>
    perRow.filter((r) => !range || (r.rowIndex >= range.firstRow && r.rowIndex <= range.lastRow));

  const unitsRange = published?.unitsRange ?? null;
  const hoursRange = published?.hoursRange ?? null;
  const unitsInRange = inRange(unitsRange).reduce((s, r) => s + r.units, 0);
  const hoursInRange = inRange(hoursRange).reduce((s, r) => s + (r.hours ?? 0), 0);

  // Day rows the tab's own totals do not reach. Reported, never blocking.
  const coverageGap: MonthlyTabOutcome['coverageGap'] = perRow
    .map((r) => {
      const missingFrom: ('units' | 'hours')[] = [];
      if (unitsRange && (r.rowIndex < unitsRange.firstRow || r.rowIndex > unitsRange.lastRow)) {
        missingFrom.push('units');
      }
      if (hoursRange && (r.rowIndex < hoursRange.firstRow || r.rowIndex > hoursRange.lastRow)) {
        missingFrom.push('hours');
      }
      return {
        rowIndex: r.rowIndex,
        dateISO: r.dateISO,
        units: r.units,
        hours: r.hours,
        missingFrom,
      };
    })
    .filter((g) => g.missingFrom.length > 0 && (g.units !== 0 || (g.hours ?? 0) !== 0));

  const reconciliation: ReconcileCheck[] = [
    check('units total (tab totals row, declared range)', unitsInRange, published?.units ?? null),
    check(
      'run hours total (tab totals row, declared range)',
      hoursInRange,
      published?.hours ?? null,
    ),
    // The OVERVIEW cell references the tab's totals cell, so it carries the same
    // range and the same figure. What it pins independently is WHICH CELL the
    // workbook itself calls the month's total — the one thing a totals-row
    // resolution can get wrong and still look self-consistent.
    check('run hours total (OVERVIEW reference)', hoursInRange, published?.overviewHours ?? null),
    check(
      'avg pocket coil / working day (OVERVIEW)',
      avgPositive(out.map((r) => r.pocketCoil)),
      published?.overviewAvgPocketCoil ?? null,
      true,
    ),
  ];

  const tabOutcome: MonthlyTabOutcome = {
    name: sheet.name,
    expected,
    status: 'extracted',
    skipReason: null,
    titleMonthRaw,
    titleYearRaw,
    headerRowIndex: header.index + 1,
    totalsRowIndex,
    dayRowsSeen,
    rowsExtracted: out.length,
    skips,
    parsedUnits,
    parsedHours,
    reconciliation,
    reconciled: reconciliation.every((c) => c.advisory || c.ok),
    coverageGap,
  };

  if (unresolvable > dayRowsSeen * 0.1) {
    return {
      outcome: { ...tabOutcome, status: 'skipped', skipReason: 'too_many_failed_rows' },
      rows: [],
    };
  }

  return { outcome: tabOutcome, rows: out };
}

/** Mean over the strictly-positive values, mirroring Excel's `AVERAGEIFS(">0")`. */
function avgPositive(values: readonly number[]): number {
  const pos = values.filter((v) => v > 0);
  return pos.length === 0 ? 0 : pos.reduce((a, b) => a + b, 0) / pos.length;
}
