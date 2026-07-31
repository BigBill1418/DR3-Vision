// ADR-0069 Amendment 1 — the trailer-list extractor.
//
// ── Why this document, and not the one the handoff recommended ──────────────
// The absorption handoff nominated the commodity-audit tracker as the first type
// to absorb, on the grounds that it reconciles commodity data against vendor
// invoices. Reading the actual file (pulled from R2, 2026-07-31) showed it does
// not contain that: it is banded, and its columns are
// `Audited | Initials | Date | 2nd Audit | Initials | Date` repeating per
// commodity. No weight, no amount, no invoice number, no variance. It records
// WHO CHECKED, not the figures. Absorbing it would have produced a queryable
// table of ticked boxes and the appearance of absorption.
//
// The trailer list is a real flat table with real operational data —
// `Date of Entry to Yard | Trailer # | Material | Weight (lbs) | Driver |
// Days in Yard | Exit Date | Notes` — so it is the honest first type.
//
// ── Resolved by MEANING, never by position ─────────────────────────────────
// The same discipline as the workbook-sync daily adapter. The live file proves
// why: its header row is row 2, its data starts in column B (column A is
// entirely empty), one header carries a trailing space (`"Driver "`) and another
// an embedded newline (`"Days in Yard\n(auto calc)"`). Ordinal mapping survives
// none of that, and a silently-shifted column is a wrong number rather than an
// error.
//
// ── What the real data forced ──────────────────────────────────────────────
// Measured across the 96 populated rows of the live file:
//   - Weight is a NUMBER on 77 rows, BLANK on 11, and the literal string "-" on
//     6. Blank and "-" both mean "not recorded" and must land as NULL. Writing 0
//     would invent six trailers weighing nothing and drag any future average
//     down with them. The raw cell text is kept alongside so "-" is recoverable.
//   - Entry date is absent on 14 rows and exit date on 4. Absent is absent.
//   - `Days in Yard` is a FORMULA cell. Its cached result is stored as what the
//     SHEET says, never recomputed — recomputing would put a number on the screen
//     that the spreadsheet does not show, which is how two systems start
//     disagreeing about a figure neither of them owns.
//   - `Material` is free text and genuinely inconsistent: "pocket coil" /
//     "pocket coils" / "Pocketcoil", "foam bales" / "Foam Bales" / "20 foam
//     bales", and a number of entries that are ORIGINS rather than materials
//     ("Red Bluff", "Recology SF", "Novato"). It is stored VERBATIM. Normalising
//     it into categories would be inventing a taxonomy the operator never
//     agreed to, and mapping it to program/non-program would be inventing a
//     billing fact.
//   - 28 rows are blank spacers between blocks. A row with no trailer number is
//     not a trailer.

import { detectHeaderRow } from './header-detect';

/** One spreadsheet cell, reduced to the three readings this extractor needs. */
export interface Cell {
  /** Display text, trimmed. '' when empty. */
  text: string;
  /** Numeric reading when the cell holds a number (or a numeric formula result). */
  num: number | null;
  /** 'YYYY-MM-DD' when the cell holds a real date. */
  date: string | null;
}

export interface TrailerRow {
  /** 1-based row number in the sheet — provenance back to the source. */
  rowIndex: number;
  entryDate: string | null;
  trailerNo: string;
  materialRaw: string | null;
  /** NULL when the sheet recorded no weight. Never 0 for a blank or a dash. */
  weightLbs: number | null;
  /** Exactly what the weight cell said, so "-" survives the trip. */
  weightRaw: string | null;
  driver: string | null;
  /** The sheet's own formula result. Not recomputed. */
  daysInYardSheet: number | null;
  exitDate: string | null;
  exitRaw: string | null;
  notes: string | null;
}

export interface TrailerExtractFailure {
  kind: 'no_header' | 'missing_columns' | 'no_rows';
  message: string;
}

export interface TrailerExtractResult {
  sheetName: string;
  headerRowIndex: number;
  headers: string[];
  rows: TrailerRow[];
  /** Rows skipped because they carried no trailer number (block spacers). */
  skippedBlank: number;
  failure: TrailerExtractFailure | null;
}

/** Collapse a header to a comparable form: no case, no runs of whitespace. */
function norm(h: string): string {
  return h.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Column meanings. `required` names the columns without which the sheet is not a
 * trailer list — the extractor REFUSES rather than absorbing a partial shape.
 */
const COLUMNS = {
  entryDate: { re: /(date of entry|entry date|date in\b)/, required: false },
  trailerNo: { re: /trailer/, required: true },
  material: { re: /(material|commodity)/, required: true },
  weight: { re: /(weight|lbs|pounds)/, required: false },
  driver: { re: /driver/, required: false },
  daysInYard: { re: /days? in yard/, required: false },
  exitDate: { re: /exit/, required: false },
  notes: { re: /note/, required: false },
} as const;

type ColumnKey = keyof typeof COLUMNS;

function resolveColumns(headers: string[]): {
  index: Partial<Record<ColumnKey, number>>;
  missing: ColumnKey[];
} {
  const index: Partial<Record<ColumnKey, number>> = {};
  for (const [key, spec] of Object.entries(COLUMNS) as [ColumnKey, { re: RegExp }][]) {
    // First match wins, scanning left to right. A trailer list does not repeat
    // its columns; if one ever did, the leftmost is the one the eye reads first.
    const at = headers.findIndex((h) => spec.re.test(norm(h)));
    if (at >= 0) index[key] = at;
  }
  const missing = (Object.keys(COLUMNS) as ColumnKey[]).filter(
    (k) => COLUMNS[k].required && index[k] === undefined,
  );
  return { index, missing };
}

/** '-', '', 'n/a' and friends all mean "the sheet did not record one". */
function isNotRecorded(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === '' || t === '-' || t === '—' || t === 'n/a' || t === 'na';
}

function cellAt(row: readonly Cell[], at: number | undefined): Cell | null {
  if (at === undefined) return null;
  return row[at] ?? null;
}

/**
 * Extract trailer rows from one sheet.
 *
 * `cells` is the whole sheet as a rectangular grid (row-major, 0-indexed). The
 * caller supplies it so this function never touches exceljs and stays testable
 * against hand-written fixtures.
 */
export function extractTrailerRows(sheetName: string, cells: Cell[][]): TrailerExtractResult {
  const detected = detectHeaderRow(cells.map((r) => r.map((c) => c.text)));

  if (detected.headerRowIndex === 0) {
    return {
      sheetName,
      headerRowIndex: 0,
      headers: [],
      rows: [],
      skippedBlank: 0,
      failure: { kind: 'no_header', message: `Sheet "${sheetName}" has no readable header row.` },
    };
  }

  const { index, missing } = resolveColumns(detected.headers);
  if (missing.length > 0) {
    // Refuse. A trailer list without a trailer column is not a trailer list, and
    // absorbing whatever else it had would fill a typed table with the wrong
    // document's data under a confident-looking name.
    return {
      sheetName,
      headerRowIndex: detected.headerRowIndex,
      headers: detected.headers,
      rows: [],
      skippedBlank: 0,
      failure: {
        kind: 'missing_columns',
        message:
          `Sheet "${sheetName}" is missing required column(s): ${missing.join(', ')}. ` +
          `Detected headers on row ${detected.headerRowIndex}: ` +
          `${detected.headers.filter(Boolean).join(' | ') || '(none)'}`,
      },
    };
  }

  const rows: TrailerRow[] = [];
  let skippedBlank = 0;

  for (let r = detected.headerRowIndex; r < cells.length; r += 1) {
    const row = cells[r];
    if (!row) continue;

    const trailerCell = cellAt(row, index.trailerNo);
    const trailerNo = (trailerCell?.text ?? '').trim();
    // A row with no trailer number is a block spacer, not a trailer. 28 of the
    // live file's rows are exactly this.
    if (trailerNo === '') {
      skippedBlank += 1;
      continue;
    }

    const weightCell = cellAt(row, index.weight);
    const weightText = weightCell?.text ?? '';
    const weightLbs =
      weightCell === null || isNotRecorded(weightText) ? null : (weightCell.num ?? null);

    const exitCell = cellAt(row, index.exitDate);
    const entryCell = cellAt(row, index.entryDate);
    const daysCell = cellAt(row, index.daysInYard);
    const materialCell = cellAt(row, index.material);
    const driverCell = cellAt(row, index.driver);
    const notesCell = cellAt(row, index.notes);

    const materialRaw = materialCell?.text.trim() ?? '';
    const driver = driverCell?.text.trim() ?? '';
    const notes = notesCell?.text.trim() ?? '';

    rows.push({
      rowIndex: r + 1,
      entryDate: entryCell?.date ?? null,
      trailerNo,
      materialRaw: materialRaw === '' ? null : materialRaw,
      weightLbs,
      weightRaw: weightText.trim() === '' ? null : weightText.trim(),
      driver: driver === '' ? null : driver,
      daysInYardSheet: daysCell?.num ?? null,
      exitDate: exitCell?.date ?? null,
      exitRaw:
        exitCell === null || exitCell.text.trim() === '' || exitCell.date !== null
          ? null
          : exitCell.text.trim(),
      notes: notes === '' ? null : notes,
    });
  }

  if (rows.length === 0) {
    // Zero rows is never recorded as a successful absorption of nothing — the
    // whole history of this pipeline is silent zeroes.
    return {
      sheetName,
      headerRowIndex: detected.headerRowIndex,
      headers: detected.headers,
      rows: [],
      skippedBlank,
      failure: {
        kind: 'no_rows',
        message: `Sheet "${sheetName}" resolved its columns but produced no trailer rows.`,
      },
    };
  }

  return {
    sheetName,
    headerRowIndex: detected.headerRowIndex,
    headers: detected.headers,
    rows,
    skippedBlank,
    failure: null,
  };
}
