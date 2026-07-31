// ADR-0067 Amendment 8 — find the REAL header row.
//
// ── The defect ──────────────────────────────────────────────────────────────
// `parse.ts` took the first non-empty row as the header, justified in a comment
// as "correct for every workbook this pipeline has seen". The 2026-07-30 audit
// falsified that **3 of 3 against live documents**: every real workbook opens
// with a merged title row, so the recorded headers were
// `["Woodland Trailer List 2025"]`, `["TEREX MACHINE MAINTENANCE LOG"]`,
// `["2026", "Commodity Audit (against Vendor Invoices)  WOODLAND"]`.
//
// That is not a cosmetic mis-label. Two mechanisms were silently dead:
//   - the STRUCTURE half of the classifier (its rules match on column names,
//     which never reached `headers[]`, so classification was filename-only); and
//   - the D7 aggregate-variance guardrail, whose monitored-column regex never
//     matched a title string — so "clean guardrail verdict" meant "there was
//     nothing to compare", not "the change was safe".
//
// ── Detect, do not assume ───────────────────────────────────────────────────
// The fix is emphatically NOT "use row 2". Some workbooks genuinely start on row
// 1, some on row 3, some have two stacked title rows. Assuming a different fixed
// row reproduces the same class of defect one row further down.
//
// A merged/title row has a characteristic shape: one or two populated cells
// against a sheet that is much wider, followed by a row with many populated
// cells that read like labels. So: score candidate rows on how WIDE they are
// relative to the widest row seen, and how LABEL-LIKE their cells are, and take
// the first that clears both.
//
// ── The chosen index is recorded ────────────────────────────────────────────
// `headerRowIndex` and the skipped `titleRows` are both kept. A wrong guess must
// be VISIBLE and correctable rather than silent — the whole reason the previous
// behaviour survived so long is that nothing ever showed what it had picked.

/** Rows examined when hunting for the header. Beyond this it is not a header. */
export const HEADER_SCAN_ROWS = 12;

export interface HeaderDetection {
  /** 1-based row number within the sheet. 0 when the sheet has no usable row. */
  headerRowIndex: number;
  headers: string[];
  /** Text of the rows skipped above the header — document/section titles. */
  titleRows: string[];
  /**
   * `strong`   — a row cleared both the width and label-likeness bars.
   * `weak`     — nothing cleared them; the widest row was taken instead.
   * `none`     — the sheet had no non-empty row at all.
   */
  confidence: 'strong' | 'weak' | 'none';
}

/** A cell that is a bare number is data, not a column name. */
function looksLikeLabel(cell: string): boolean {
  const s = cell.trim();
  if (s === '') return false;
  // A pure number, currency, or percentage is a value.
  if (/^[-+$(]?\s*[\d,.]+\s*[%)]?$/.test(s)) return false;
  // A date is a value too. (Excel serials arrive as numbers, caught above.)
  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(s)) return false;
  // Column names are short. A 200-character cell is prose or a merged title.
  if (s.length > 60) return false;
  return true;
}

function populatedCount(row: readonly string[]): number {
  return row.reduce((n, c) => (c.trim() === '' ? n : n + 1), 0);
}

/**
 * Choose the header row from the first `HEADER_SCAN_ROWS` rows of a sheet.
 *
 * `rows` is 0-indexed; `headerRowIndex` is returned 1-based to match how a human
 * (and Excel) counts rows, because this value is going on a screen.
 */
export function detectHeaderRow(rows: ReadonlyArray<ReadonlyArray<string>>): HeaderDetection {
  const scan = rows.slice(0, HEADER_SCAN_ROWS);
  const nonEmpty = scan
    .map((row, i) => ({ row, i, populated: populatedCount(row) }))
    .filter((r) => r.populated > 0);

  if (nonEmpty.length === 0) {
    return { headerRowIndex: 0, headers: [], titleRows: [], confidence: 'none' };
  }

  // The widest row in the scan window is the best available estimate of how many
  // columns the sheet really has. A title row is narrow against it; a header row
  // is not.
  const maxWidth = Math.max(...nonEmpty.map((r) => r.populated));
  // Two columns minimum — a "wide" row on a two-column sheet is still 2.
  const widthBar = Math.max(2, Math.ceil(maxWidth * 0.6));

  for (const cand of nonEmpty) {
    if (cand.populated < widthBar) continue;
    const filled = cand.row.filter((c) => c.trim() !== '');
    const labels = filled.filter(looksLikeLabel).length;
    // Mostly labels rather than mostly values. A row of numbers that happens to
    // be wide is the first DATA row, not the header.
    if (labels / filled.length < 0.6) continue;

    return {
      headerRowIndex: cand.i + 1,
      headers: cand.row.map((c) => c.trim()),
      titleRows: scan
        .slice(0, cand.i)
        .map((r) => r.filter((c) => c.trim() !== '').join(' | '))
        .filter((s) => s !== ''),
      confidence: 'strong',
    };
  }

  // Nothing cleared the bars. Fall back to the widest row — the same information
  // the old code would have produced at best — but SAY so, so the weakness is on
  // the record instead of being indistinguishable from a confident read.
  const widest = nonEmpty.reduce((a, b) => (b.populated > a.populated ? b : a));
  return {
    headerRowIndex: widest.i + 1,
    headers: widest.row.map((c) => c.trim()),
    titleRows: scan
      .slice(0, widest.i)
      .map((r) => r.filter((c) => c.trim() !== '').join(' | '))
      .filter((s) => s !== ''),
    confidence: 'weak',
  };
}
