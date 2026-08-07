// ADR-0069 Amendment 3 — the commodity audit-coverage extractor.
//
// ── What this document is, and what it emphatically is NOT ──────────────────
// The trailer extractor's own header comment records why the commodity tracker
// was passed over as the first absorption type: it carries no tonnage, no
// amount, no invoice number, no variance. That reading was right, and it stands.
// Verified again against the live bytes: still no figures anywhere on either
// sheet.
//
// But "not a figures document" is not the same as "not worth absorbing". What it
// actually is, is an AUDIT-COVERAGE MATRIX: for every commodity stream × every
// month it records whether that month's audit against vendor invoices was done,
// by whom, and when. The queryable fact is COVERAGE — which months nobody has
// checked yet — and that is a real operational question with a real answer.
//
// So this extractor deliberately produces NO totals and NO money. If a future
// caller wants a number out of this, the only honest one is a count of months.
//
// ── The sheets are STACKED SUB-TABLES, not one table ───────────────────────
// This is Amendment 3's correction, and it is the whole reason this file was
// rewritten. The first cut assumed ONE header row per sheet with all streams
// side by side. Measured against the live workbook, that is false:
//
//   Commodity Audit 2026 (60 rows)     Commodity Audit 2025 (45 rows)
//     header row 4  → 7 streams          header row 4  → 6 streams
//     header row 18 → 2 streams          header row 18 → 2 streams
//     header row 20 → 1 stream           header row 32 → 1 stream
//     header row 32 → 1 stream
//     header row 47 → 1 stream
//     = 12 streams                       = 9 streams
//
// Sub-tables are staggered in BOTH axes. The row-20 block starts two rows below
// the row-18 block and lives in entirely different columns, so the two OVERLAP
// vertically while never touching. There is no global row range per sub-table;
// the bound has to be per column group.
//
// ── What the single-header assumption actually did ─────────────────────────
// It found only the FIRST header row and then scanned every row beneath it for
// month labels in the TOP block's columns. The lower blocks' month rows are in
// those same columns, so they were swept up and attributed to the wrong stream:
//
//     2026: 144 rows emitted under only 7 distinct labels — 60 DUPLICATE
//           (stream, month) pairs. 2025: 108 rows, 6 labels, 36 duplicates.
//
// Two consequences, and note that the row TOTAL was right both times, which is
// exactly why it was invisible:
//   - Five real streams (METAL - SA, WOOD- Sierra, WOOD- Yolo, WOOD- Renovation,
//     PLASTIC/CARDBOARD/SHODDY) vanished, and their audit state was recorded
//     under other streams' names. Silently wrong data about who checked what.
//   - `doc_commodity_audit_rows` carries a UNIQUE index on
//     (doc_source_version_id, sheet_name, stream_label, month_label). Sixty
//     duplicate pairs means `createMany` throws P2002 and the whole absorption
//     fails in production.
// Because the second one is a hard production failure, duplicates are now a
// REFUSAL (`duplicate_stream_months`) rather than something a caller might miss:
// a named refusal naming the offending pairs beats an opaque P2002 at 3 a.m.
//
// ── Everything is DETECTED, nothing is counted off ─────────────────────────
//   - Header rows: every row anywhere in the sheet carrying "Audited" with
//     "Initials" and "Date". Not the first, and not within a scan window — the
//     live header rows reach row 47.
//   - Streams: every column whose header row says "Audited". 7/2/1/1/1, never a
//     stride or a count.
//   - Month column: the column, within the run of blank-headered columns left of
//     "Audited", that actually holds month names. Makes the blank spacer between
//     blocks irrelevant.
//   - Data bound: from a block's header row down to the next header row that has
//     an "Audited" column INSIDE this block's column span. That is what keeps
//     the row-18 and row-20 blocks from eating each other's rows despite
//     overlapping vertically.
//
// ── Banner rows are found by searching UP, not by a fixed offset ───────────
// The top block has two banner rows above its header (group on 2, stream on 3).
// The sub-tables do not: only ONE free row separates the top block's last month
// (16) from the row-18 header, so a fixed h-2/h-1 offset would read a month row
// as a group name and label a stream "Dec". So the label is the nearest non-empty
// cell scanning UP from the header row, stopping at the first month label or
// header row — either of which means we have walked into the block above. The
// group is the one row further up, when that row is neither. Sub-tables
// therefore report an EMPTY group rather than an inherited one. Empty is
// visibly missing; inherited would be silently wrong.
//
// ── The mess that must SURVIVE, not be cleaned ─────────────────────────────
//   - A "Date" cell can hold the literal word "working" (2026 METAL, March /
//     April / May). It is a status, not a date. It lands in `auditDateRaw` and
//     leaves `auditDateISO` null. Coercing it to the 1st of the month would put
//     an audit date on the record for an audit that has not finished.
//   - Initials can be the literal "NONE" (2025 WOOD, Aug). That is a recorded
//     answer, not an absence, so it is kept verbatim rather than nulled.
//   - Date cells are frequently EMPTY while Audited is true (all of 2025 METAL).
//     `auditDateRaw` is therefore always what the cell said — '' when the cell
//     existed and was empty, null only when the block had no such cell at all.
//     The distinction is the difference between "checked, date not written down"
//     and "this sheet has no date column".
//   - One date reads 2025-01-07 on a Dec row of the 2025 sheet — almost certainly
//     a typo for 2026-01-07. It is recorded VERBATIM. Correcting an operator's
//     entry is how a system starts holding a figure the source does not.
//   - A marker cell reading "* no entries" sits in a month column (2026, row 31).
//     It is not a month and emits nothing.
//   - Row 1 of some sheets carries an Excel error cell. Error cells read as empty.
//
// ── "Not recorded" is not "no" ─────────────────────────────────────────────
// `audited` is `boolean | null`. An empty Audited cell is null, never false.
// This is the same rule the trailer extractor applies to a blank weight, and it
// matters more here, not less: the entire point of this document is finding the
// months nobody has audited. If "not recorded" collapsed into false, a coverage
// report could not distinguish "we checked and it failed" from "nobody looked",
// and the loudest finding this document can produce would be silently gone.

import type { Cell } from './trailer-extract';

/** Below this an audit "date" is an Excel epoch artefact, not an audit. */
const EARLIEST_PLAUSIBLE = '2015-01-01';
/** Above this it is a typo, not a date. */
const LATEST_PLAUSIBLE = '2035-12-31';

export interface CommodityAuditRow {
  /** 1-based sheet row of this month row — provenance back to the source. */
  rowIndex: number;
  /** 1-based column holding the month label. */
  monthColIndex: number;
  /** Banner above this block's header row. '' for sub-tables that carry none. */
  streamGroup: string;
  streamLabel: string;
  /** VERBATIM. "Sept" stays "Sept"; "March" stays "March". */
  monthLabel: string;
  /** 1..12. Null when the label does not map — never guessed. */
  monthNumber: number | null;
  /** NULL = the sheet did not record one. Never coerced to false. */
  audited: boolean | null;
  initials: string | null;
  /** Set ONLY for a real date in a plausible range. */
  auditDateISO: string | null;
  /** ALWAYS what the cell said: "working", "", a date string. */
  auditDateRaw: string | null;
  secondAudit: boolean | null;
  secondInitials: string | null;
  secondAuditDateISO: string | null;
  secondAuditDateRaw: string | null;
}

export interface CommodityStreamBlock {
  group: string;
  label: string;
  /** 1-based row of the sub-table this stream belongs to. */
  headerRowIndex: number;
  /** 1-based. */
  monthCol: number;
  /** 1-based. */
  auditedCol: number;
}

export interface CommodityExtractResult {
  sheetName: string;
  /** Parsed from the row-1 col-1 banner. */
  year: number | null;
  /** The FIRST detected header row, 1-based. Null when the sheet was refused. */
  headerRowIndex: number | null;
  /** EVERY detected header row, 1-based — the sheets carry several. */
  headerRowIndexes: number[];
  streams: CommodityStreamBlock[];
  rows: CommodityAuditRow[];
  /**
   * "<label>::<month>" for each pair emitted more than once. Must be empty: the
   * destination table's UNIQUE index would reject the batch with P2002.
   */
  duplicateStreamMonths: string[];
  /** Non-null when the sheet was refused. Never throws for a bad sheet. */
  failure: { kind: string; message: string } | null;
}

/** A block with its resolved geometry. -1 for a column the block does not have. */
interface ResolvedBlock extends CommodityStreamBlock {
  headerRow0: number;
  monthCol0: number;
  auditedCol0: number;
  initialsCol0: number;
  dateCol0: number;
  secondAuditCol0: number;
  secondInitialsCol0: number;
  secondDateCol0: number;
  /** Exclusive 0-based row at which this block's data stops. */
  dataEnd: number;
}

/** Collapse a header to a comparable form: no case, no runs of whitespace. */
function norm(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[:.?]+$/, '');
}

/**
 * An Excel error cell carries no reading. Row 1 of a live sheet has one, and a
 * '#REF!' treated as a label would be a plausible-looking stream name.
 */
const ERROR_TEXT = /^#(ref|value|div\/0|name|n\/a|null|num|spill|calc)!?\??$/i;

/** Cell text with error cells reduced to empty. '' when the cell is empty. */
function textOf(c: Cell | null | undefined): string {
  if (!c) return '';
  const t = c.text.trim();
  return ERROR_TEXT.test(t) ? '' : t;
}

/**
 * Month labels, exactly as this document is allowed to read them.
 *
 * The live sheets abbreviate inconsistently — Jan / Feb / March / April / May /
 * June / July / Aug / Sept / Oct / Nov / Dec — so the table accepts both the
 * short and long forms, plus the 4-letter "Sept". The LABEL is stored verbatim
 * regardless; this table only produces the sortable number beside it.
 */
const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Is this cell a month row's label at all?
 *
 * Deliberately WIDER than `monthNumberFor`. A cell reading "June/July" (the
 * shape an operator writes when a month boundary was audited in one pass) is a
 * month row and its label is evidence, so it is emitted — but it does not map
 * to one number, so `monthNumber` stays null rather than picking one. A cell
 * reading "Total", "YTD" or the live sheet's "* no entries" marker is neither,
 * and emits nothing.
 */
function looksLikeMonth(label: string): boolean {
  return /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(norm(label));
}

/** 1..12, or null when the verbatim label does not map. Never guessed. */
function monthNumberFor(label: string): number | null {
  return MONTH_NUMBERS[norm(label)] ?? null;
}

/**
 * An Audited / 2nd Audit cell.
 *
 * Blank is NULL — "nobody recorded an answer" — and is the finding this whole
 * document exists to surface. An unrecognised word is also null rather than a
 * guess in either direction.
 */
function boolOf(c: Cell | null): boolean | null {
  if (c === null) return null;
  const t = norm(textOf(c));
  if (t === '') return null;
  if (['x', 'y', 'yes', 'true', 'done', 'complete', 'completed', 'audited', '✓', '✔'].includes(t)) {
    return true;
  }
  if (['n', 'no', 'false', 'not done'].includes(t)) return false;
  // A numeric checkbox reading, when the sheet used 1/0 rather than a tick.
  if (c.num === 1) return true;
  if (c.num === 0) return false;
  return null;
}

/** A value field: '' means the sheet left it blank. "NONE" is an answer, kept. */
function valueOf(c: Cell | null): string | null {
  const t = textOf(c);
  return t === '' ? null : t;
}

/** ALWAYS what the cell said. Null only when the block has no such column. */
function rawOf(c: Cell | null): string | null {
  return c === null ? null : textOf(c);
}

/** A date, only when the cell held a real one inside a plausible range. */
function isoOf(c: Cell | null): string | null {
  if (c === null || c.date === null) return null;
  return c.date >= EARLIEST_PLAUSIBLE && c.date <= LATEST_PLAUSIBLE ? c.date : null;
}

function at(row: readonly Cell[] | undefined, i: number): Cell | null {
  if (!row || i < 0) return null;
  return row[i] ?? null;
}

/**
 * EVERY row carrying the audit vocabulary — the sheets hold several stacked
 * sub-tables and the lowest header row is 47, so this scans the whole sheet
 * rather than a header window.
 */
function findHeaderRows(cells: Cell[][]): number[] {
  const out: number[] = [];
  for (let r = 0; r < cells.length; r += 1) {
    const row = cells[r];
    if (!row) continue;
    const seen = new Set(row.map((c) => norm(textOf(c))));
    if (seen.has('audited') && seen.has('initials') && seen.has('date')) out.push(r);
  }
  return out;
}

/** Nearest non-empty cell scanning LEFT from `from` down to `to`. */
function nearestLeft(row: readonly Cell[] | undefined, from: number, to: number): string {
  for (let c = from; c >= to; c -= 1) {
    const t = textOf(row?.[c]);
    if (t !== '') return t;
  }
  return '';
}

/**
 * The group and stream banners for one block, found by searching UP.
 *
 * A fixed h-2 / h-1 offset is wrong: only one free row separates the top block's
 * last month row from the row-18 sub-table's header, so h-2 lands on a month row
 * and would name a stream "Dec". Stopping at the first month label or header row
 * is what keeps a sub-table from inheriting the block above it.
 */
function resolveBanners(
  cells: Cell[][],
  headerRow0: number,
  monthCol0: number,
  auditedCol0: number,
  headerRowSet: ReadonlySet<number>,
): { group: string; label: string } {
  const left = Math.max(0, monthCol0);
  let labelRow = -1;
  for (let r = headerRow0 - 1; r >= 0; r -= 1) {
    if (headerRowSet.has(r)) break;
    const t = nearestLeft(cells[r], auditedCol0, left);
    if (t === '') continue;
    if (looksLikeMonth(t)) break; // we have walked into the block above
    labelRow = r;
    break;
  }
  if (labelRow < 0) return { group: '', label: '' };

  const label = nearestLeft(cells[labelRow], auditedCol0, left);
  const g = labelRow - 1;
  if (g < 0) return { group: '', label };

  // The group row is rejected COLUMN-WISE, not row-wise.
  //
  // `headerRowSet.has(g)` was the obvious test and it is wrong here, because
  // blocks overlap vertically in DIFFERENT COLUMNS: row 18 of the 2026 sheet is
  // the header row for the METAL - SA / WOOD- Sierra block (columns 3–16) AND
  // carries the group banner "OTHER" at column 42 for the PLASTIC block whose
  // own header sits two rows lower. Rejecting the whole row cost that block its
  // real group.
  //
  // What disqualifies the candidate is that it belongs to the block ABOVE, and
  // the reliable evidence for that is this block's MONTH column holding a month
  // on that row — i.e. row `g` is a data row, not a banner. Testing the month
  // column specifically (rather than whatever `nearestLeft` happens to find) is
  // load-bearing: on a data row `nearestLeft` returns the Audited checkbox, so
  // the naive version produced groups literally named "false" and "true".
  if (monthCol0 >= 0 && looksLikeMonth(textOf(cells[g]?.[monthCol0] ?? EMPTY_CELL))) {
    return { group: '', label };
  }

  const gt = nearestLeft(cells[g], auditedCol0, left);
  const disqualified = gt === '' || looksLikeMonth(gt) || isHeaderToken(gt) || isBooleanish(gt);
  return { group: disqualified ? '' : gt, label };
}

const EMPTY_CELL: Cell = { text: '', num: null, date: null };

/** A banner cell that is really one of this table's column headings. */
function isHeaderToken(text: string): boolean {
  return ['audited', 'initials', 'date', '2nd audit'].includes(norm(text));
}

/**
 * A checkbox value that has been mistaken for a banner. Belt to the month
 * column's braces: no commodity group is called "true".
 */
function isBooleanish(text: string): boolean {
  return norm(text) === 'true' || norm(text) === 'false';
}

/**
 * Resolve one block's columns by what their headers say, bounded by the next
 * block on the SAME header row. The order is Audited | Initials | Date |
 * 2nd Audit | Initials | Date, so "before / after the 2nd Audit column" is what
 * separates the two identically-named Initials and Date columns — not offsets,
 * and emphatically not a leftmost-match-wins scan across the whole row.
 */
function resolveBlockColumns(
  header: readonly Cell[],
  auditedCol0: number,
  blockEnd: number,
): Pick<
  ResolvedBlock,
  'initialsCol0' | 'dateCol0' | 'secondAuditCol0' | 'secondInitialsCol0' | 'secondDateCol0'
> {
  let initialsCol0 = -1;
  let dateCol0 = -1;
  let secondAuditCol0 = -1;
  let secondInitialsCol0 = -1;
  let secondDateCol0 = -1;
  let pastSecond = false;

  for (let c = auditedCol0 + 1; c < blockEnd; c += 1) {
    const h = norm(textOf(header[c]));
    if (h === '') continue;
    if (/audit/.test(h) && /(2nd|second)/.test(h)) {
      secondAuditCol0 = c;
      pastSecond = true;
      continue;
    }
    if (h === 'initials') {
      if (!pastSecond && initialsCol0 < 0) initialsCol0 = c;
      else if (pastSecond && secondInitialsCol0 < 0) secondInitialsCol0 = c;
      continue;
    }
    if (h === 'date') {
      if (!pastSecond && dateCol0 < 0) dateCol0 = c;
      else if (pastSecond && secondDateCol0 < 0) secondDateCol0 = c;
    }
  }
  return { initialsCol0, dateCol0, secondAuditCol0, secondInitialsCol0, secondDateCol0 };
}

/** The contiguous run of blank-headered columns immediately left of `auditedCol0`. */
function blankRunLeft(header: readonly Cell[], auditedCol0: number): number[] {
  const run: number[] = [];
  for (let c = auditedCol0 - 1; c >= 0; c -= 1) {
    if (norm(textOf(header[c])) !== '') break;
    run.push(c);
  }
  return run;
}

/** The year banner: the first bare 4-digit year on row 1. */
function findYear(cells: Cell[][]): number | null {
  for (const c of cells[0] ?? []) {
    const t = textOf(c);
    if (!/^\d{4}$/.test(t)) continue;
    const y = Number(t);
    if (y >= 1990 && y <= 2100) return y;
  }
  return null;
}

/** The first few rows as text, so a refusal names what the sheet actually held. */
function describeRows(cells: Cell[][], count: number): string {
  return (
    cells
      .slice(0, count)
      .map((row, i) => {
        const filled = row.map(textOf).filter((t) => t !== '');
        return `row ${i + 1}: ${filled.join(' | ') || '(empty)'}`;
      })
      .join('; ') || '(the sheet has no rows)'
  );
}

/**
 * Extract the audit-coverage matrix from one sheet.
 *
 * `cells` is the whole sheet as a rectangular grid (row-major, 0-indexed). The
 * caller supplies it so this function never touches exceljs and stays testable
 * against hand-written fixtures.
 *
 * Rows are emitted stream-major, streams ordered by header row then column —
 * the order a coverage report reads them in.
 */
export function extractCommodityAuditRows(
  sheetName: string,
  cells: Cell[][],
): CommodityExtractResult {
  const year = findYear(cells);
  const headerRows = findHeaderRows(cells);

  if (headerRows.length === 0) {
    // Refuse. The row-1 banner is wide and label-like enough to be mistaken for
    // a header by a generic scorer, and absorbing it would produce a stream
    // called "Commodity Audit (against Vendor Invoices)  WOODLAND" with twelve
    // months of nothing under it — which looks exactly like a successful read.
    return {
      sheetName,
      year,
      headerRowIndex: null,
      headerRowIndexes: [],
      streams: [],
      rows: [],
      duplicateStreamMonths: [],
      failure: {
        kind: 'no_header_row',
        message:
          `Sheet "${sheetName}" has no commodity-audit header row ` +
          `(a row carrying "Audited" with "Initials" and "Date") anywhere in its ` +
          `${cells.length} row(s). Found instead — ${describeRows(cells, 4)}`,
      },
    };
  }

  const headerRowSet = new Set(headerRows);
  const width = Math.max(...cells.map((r) => r.length), 1);

  // Pass 1 — every block on every header row, with its columns resolved.
  interface Draft extends Omit<ResolvedBlock, 'dataEnd' | 'group' | 'label' | 'monthCol'> {
    run: number[];
    spanEnd: number;
  }
  const drafts: Draft[] = [];

  for (const headerRow0 of headerRows) {
    const header = cells[headerRow0] ?? [];
    const auditedCols: number[] = [];
    for (let c = 0; c < header.length; c += 1) {
      if (norm(textOf(header[c])) === 'audited') auditedCols.push(c);
    }

    auditedCols.forEach((auditedCol0, i) => {
      const blockEnd = auditedCols[i + 1] ?? width;
      const cols = resolveBlockColumns(header, auditedCol0, blockEnd);
      const run = blankRunLeft(header, auditedCol0);
      const lastCol = Math.max(
        auditedCol0,
        cols.initialsCol0,
        cols.dateCol0,
        cols.secondAuditCol0,
        cols.secondInitialsCol0,
        cols.secondDateCol0,
      );
      drafts.push({
        headerRow0,
        headerRowIndex: headerRow0 + 1,
        auditedCol0,
        auditedCol: auditedCol0 + 1,
        monthCol0: run[0] ?? -1,
        ...cols,
        run,
        // The span [auditedCol0, lastCol] is what decides which LOWER header row
        // ends this block's data. It deliberately starts at Audited and NOT at
        // the blank run: a block sitting far right has blank headers all the way
        // to column 0, so a run-based left edge would swallow every other
        // sub-table's Audited column and truncate this block's data. (Measured:
        // the row-20 PLASTIC block lost its Dec row to the row-32 WOOD header,
        // 11 months instead of 12.) Nothing is lost by starting at Audited —
        // the month column is blank-headered, so no other block's "Audited" can
        // ever live there.
        spanEnd: lastCol + 1,
      });
    });
  }

  // Pass 2 — bound each block's data by the next header row that actually
  // OVERLAPS its columns. Blocks are not globally row-aligned: the row-18 and
  // row-20 sub-tables overlap vertically and must not truncate each other.
  const blocks: ResolvedBlock[] = drafts.map((dr) => {
    let dataEnd = cells.length;
    for (const h of headerRows) {
      if (h <= dr.headerRow0 || h >= dataEnd) continue;
      const header = cells[h] ?? [];
      for (let c = dr.auditedCol0; c < dr.spanEnd; c += 1) {
        if (norm(textOf(header[c])) === 'audited') {
          dataEnd = h;
          break;
        }
      }
    }

    // The month column is the NEAREST blank-headered column left of "Audited".
    //
    // Measured across all 12 blocks of the 2026 sheet and all 9 of 2025: the
    // per-block column order is `… | Date | (spacer) | month | Audited | …`, so
    // the blank spacer separating two blocks always sits to the LEFT of the
    // month column, never between it and Audited. Nearest is therefore always
    // right, and FARTHEST is the regression to guard against — it picks the
    // spacer (or column 0) and the block emits nothing.
    //
    // An earlier cut resolved this by probing each blank column for month names.
    // That probe could not be made to fail against either real sheet: it always
    // agreed with "nearest". Code that no falsification can turn red is not a
    // safeguard, it is decoration, so it is gone and a test pins the columns.
    const monthCol0 = dr.run[0] ?? -1;

    const { group, label } = resolveBanners(
      cells,
      dr.headerRow0,
      monthCol0,
      dr.auditedCol0,
      headerRowSet,
    );

    return {
      group,
      label,
      headerRowIndex: dr.headerRowIndex,
      headerRow0: dr.headerRow0,
      monthCol: monthCol0 + 1,
      monthCol0,
      auditedCol: dr.auditedCol,
      auditedCol0: dr.auditedCol0,
      initialsCol0: dr.initialsCol0,
      dateCol0: dr.dateCol0,
      secondAuditCol0: dr.secondAuditCol0,
      secondInitialsCol0: dr.secondInitialsCol0,
      secondDateCol0: dr.secondDateCol0,
      dataEnd,
    };
  });

  const rows: CommodityAuditRow[] = [];
  for (const b of blocks) {
    if (b.monthCol0 < 0) continue;
    for (let r = b.headerRow0 + 1; r < b.dataEnd; r += 1) {
      const sheetRow = cells[r];
      const monthLabel = textOf(at(sheetRow, b.monthCol0));
      // A row without a month label in THIS block's month column is a spacer, a
      // banner for the block below, or the "* no entries" marker — not a month.
      if (!looksLikeMonth(monthLabel)) continue;

      const dateCell = at(sheetRow, b.dateCol0);
      const secondDateCell = at(sheetRow, b.secondDateCol0);

      rows.push({
        rowIndex: r + 1,
        monthColIndex: b.monthCol0 + 1,
        streamGroup: b.group,
        streamLabel: b.label,
        monthLabel,
        monthNumber: monthNumberFor(monthLabel),
        audited: boolOf(at(sheetRow, b.auditedCol0)),
        initials: valueOf(at(sheetRow, b.initialsCol0)),
        auditDateISO: isoOf(dateCell),
        auditDateRaw: rawOf(dateCell),
        secondAudit: boolOf(at(sheetRow, b.secondAuditCol0)),
        secondInitials: valueOf(at(sheetRow, b.secondInitialsCol0)),
        secondAuditDateISO: isoOf(secondDateCell),
        secondAuditDateRaw: rawOf(secondDateCell),
      });
    }
  }

  const streams: CommodityStreamBlock[] = blocks.map((b) => ({
    group: b.group,
    label: b.label,
    headerRowIndex: b.headerRowIndex,
    monthCol: b.monthCol,
    auditedCol: b.auditedCol,
  }));

  const seen = new Set<string>();
  const duplicateStreamMonths: string[] = [];
  for (const r of rows) {
    const key = `${r.streamLabel}::${r.monthLabel}`;
    if (seen.has(key)) duplicateStreamMonths.push(key);
    else seen.add(key);
  }

  const base = {
    sheetName,
    year,
    headerRowIndex: headerRows[0]! + 1,
    headerRowIndexes: headerRows.map((h) => h + 1),
    streams,
    duplicateStreamMonths,
  };

  if (rows.length === 0) {
    // Zero rows is never recorded as a successful absorption of nothing. The
    // whole history of this pipeline is silent zeroes.
    return {
      ...base,
      rows: [],
      failure: {
        kind: 'no_month_rows',
        message:
          `Sheet "${sheetName}" found header row(s) ${base.headerRowIndexes.join(', ')} and ` +
          `${streams.length} stream block(s), but no month rows beneath them. ` +
          `Stream(s): ${streams.map((s) => s.label || '(unlabelled)').join(' | ') || '(none)'}`,
      },
    };
  }

  if (duplicateStreamMonths.length > 0) {
    // REFUSE. Every (stream, month) pair is unique in a correctly-read sheet, so
    // a duplicate means block detection has mis-attributed somebody's rows — the
    // exact defect Amendment 3 exists to fix. It is also a hard production
    // failure: the destination UNIQUE index rejects the batch with P2002, which
    // says nothing about which streams collided. This says.
    return {
      ...base,
      rows,
      failure: {
        kind: 'duplicate_stream_months',
        message:
          `Sheet "${sheetName}" produced ${duplicateStreamMonths.length} duplicate ` +
          `(stream, month) pair(s) across ${streams.length} stream(s) — the destination ` +
          `UNIQUE index would reject this batch. Offenders include: ` +
          `${duplicateStreamMonths.slice(0, 5).join(', ')}. This means month rows were ` +
          `attributed to the wrong stream, not that the document repeats itself.`,
      },
    };
  }

  return { ...base, rows, failure: null };
}
