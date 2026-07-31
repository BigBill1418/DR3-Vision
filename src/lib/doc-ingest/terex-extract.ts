// ADR-0069 Amendment 2 — the TEREX maintenance-log extractor.
//
// ── This one carries MONEY, so it stages ───────────────────────────────────
// `Estimated cost`, `Actual Repair Cost` and `Amount Credited` are real dollars.
// Under the absorption contract, money-touching extraction is preview-then-
// confirm: rows land STAGED, the totals are shown, and a human confirms before
// anything counts. The trailer list went straight in because it carries weights
// and dates; this does not.
//
// ── The finding that makes staging non-negotiable ──────────────────────────
// The real workbook (pulled from R2, 2026-07-31) has 40 sheets, of which TWO
// are maintenance logs: `Maintenance Log 2025` and `Maintenance Log2026`. They
// are not two years of data. Measured:
//
//     2025: 55 distinct events, actual repair total $77,067.94
//     2026: 80 distinct events, actual repair total $77,067.94
//     shared 55 · only-in-2025 ZERO · only-in-2026 25
//
// The 2025 sheet is a strict SUBSET — a stale snapshot of the same cumulative
// log. Absorbing "every sheet that resolves" (which is what the trailer
// extractor correctly does, because a trailer workbook has one sheet) would
// produce **$154,135.88 — exactly double the real figure.** So this extractor
// DEDUPES ACROSS SHEETS and reports what it removed, and the preview shows the
// totals so a human sees $77k rather than discovering $154k downstream.
//
// ── The other 38 sheets are deliberately not absorbed ──────────────────────
// They are monthly operating logs (`Jan 2026` … daily units and machine hours),
// pivot/summary tabs (`OVERVIEW2026` at 57 columns, `Combined Totals`,
// `Annual Cost`), blank `Template`s, and a `diesel` tab. Two reasons to leave
// them:
//   - The summary tabs are DERIVED from the monthly ones. Absorbing both a
//     source and its rollup double-counts by construction.
//   - The monthly tabs carry processed units per day, which is
//     `processed_units_daily` territory. Extracting them here would be another
//     source of the same figure.
//     NOTE (2026-07-31): this comment used to say "sole writer workbook-sync".
//     That is wrong — three writers exist (super-admin entry route, MyMRC
//     processed bridge, workbook-sync), governed by a PRECEDENCE rule
//     (`source='mymrc' AND closed_at IS NULL`). Adding a fourth participant to a
//     precedence rule is no safer than breaking an exclusive lock.
// A sheet is a maintenance log because its HEADERS say so, never because of its
// name.

import { detectHeaderRow } from './header-detect';
import type { Cell } from './trailer-extract';

/** Below this a "date" is an Excel epoch artefact, not a maintenance event. */
const EARLIEST_PLAUSIBLE = '2000-01-01';
/** Above this it is a typo, not a date. */
const LATEST_PLAUSIBLE = '2100-01-01';

export interface TerexRow {
  rowIndex: number;
  sheetName: string;
  /** Only when the cell held a real, plausible date. */
  eventDate: string | null;
  /** ALWAYS what the cell said. The date column is not trustworthy — see below. */
  eventDateRaw: string | null;
  timeRaw: string | null;
  issue: string | null;
  measuresTaken: string | null;
  /** Free text in the real file ("2 weeks"), so it stays text. */
  estimatedTimeCost: string | null;
  estimatedCost: number | null;
  notes: string | null;
  actualRepairCost: number | null;
  amountCredited: number | null;
  /** Identity used to remove the same event appearing on two sheets. */
  dedupKey: string;
}

export interface TerexSheetOutcome {
  sheetName: string;
  /** Why a sheet was not treated as a maintenance log. */
  skipped: 'not_a_maintenance_log' | null;
  headerRowIndex: number;
  eventsFound: number;
  scaffoldRows: number;
  exampleRows: number;
}

export interface TerexExtractResult {
  rows: TerexRow[];
  sheets: TerexSheetOutcome[];
  /** Events dropped because an earlier sheet already carried them. */
  duplicatesRemoved: number;
  /** Sheet names that contributed the duplicates, for the preview. */
  duplicateSources: string[];
  /** Events whose date cell could not be trusted into a real date. */
  undatedEvents: number;
  totals: { estimatedCost: number; actualRepairCost: number; amountCredited: number };
}

function norm(h: string): string {
  return h.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A maintenance log is identified by its COLUMNS, not its tab name.
 *
 * `Jan 2026` and `OVERVIEW2026` both mention Terex; neither is a maintenance
 * log. Requiring the issue/measures/repair-cost trio is what separates the log
 * from the 38 sheets that must not be absorbed.
 */
interface MaintenanceColumns {
  date: number;
  time: number;
  issue: number;
  measures: number;
  estTimeCost: number;
  estCost: number;
  notes: number;
  actualCost: number;
  credited: number;
}

function resolveMaintenanceColumns(headers: string[]): MaintenanceColumns | null {
  const find = (re: RegExp): number => headers.findIndex((h) => re.test(norm(h)));
  const idx = {
    date: find(/^date\b/),
    time: find(/^time\b/),
    issue: find(/\bissue\b/),
    measures: find(/measures? taken/),
    estTimeCost: find(/estimated repair time/),
    estCost: find(/estimated cost/),
    notes: find(/^notes/),
    actualCost: find(/actual repair cost/),
    credited: find(/amount credited/),
  };
  if (idx.issue < 0 || idx.measures < 0 || idx.actualCost < 0) return null;
  return idx;
}

function at(row: readonly Cell[], i: number | undefined): Cell | null {
  if (i === undefined || i < 0) return null;
  return row[i] ?? null;
}

function text(c: Cell | null): string | null {
  const t = c?.text.trim() ?? '';
  return t === '' ? null : t;
}

/** A cost cell: a number is a number; blank is NOT RECORDED, never zero. */
function money(c: Cell | null): number | null {
  if (c === null) return null;
  if (c.text.trim() === '') return null;
  return c.num ?? null;
}

export function extractTerexRows(sheets: { name: string; cells: Cell[][] }[]): TerexExtractResult {
  const outcomes: TerexSheetOutcome[] = [];
  const rows: TerexRow[] = [];
  const seen = new Map<string, string>(); // dedupKey -> sheet that claimed it
  let duplicatesRemoved = 0;
  const duplicateSources = new Set<string>();

  for (const sheet of sheets) {
    const detected = detectHeaderRow(sheet.cells.map((r) => r.map((c) => c.text)));
    const cols = detected.headerRowIndex === 0 ? null : resolveMaintenanceColumns(detected.headers);

    if (cols === null) {
      outcomes.push({
        sheetName: sheet.name,
        skipped: 'not_a_maintenance_log',
        headerRowIndex: detected.headerRowIndex,
        eventsFound: 0,
        scaffoldRows: 0,
        exampleRows: 0,
      });
      continue;
    }

    let scaffoldRows = 0;
    let exampleRows = 0;
    let eventsFound = 0;

    for (let r = detected.headerRowIndex; r < sheet.cells.length; r += 1) {
      const row = sheet.cells[r];
      if (!row) continue;

      // The real file's row 3 is an INSTRUCTIONAL example — column A literally
      // reads "example". Absorbing it would create a maintenance record for a
      // repair that never happened ("dripping oil from the back", Powerscreen).
      if ((row[0]?.text ?? '').trim().toLowerCase() === 'example') {
        exampleRows += 1;
        continue;
      }

      const issue = text(at(row, cols.issue));
      const measures = text(at(row, cols.measures));
      const actualCost = money(at(row, cols.actualCost));
      const credited = money(at(row, cols.credited));
      const estCost = money(at(row, cols.estCost));

      // The log is a year/month scaffold: rows carrying only a year in column A
      // or a month name in the date column are section headings, not events.
      if (
        issue === null &&
        measures === null &&
        actualCost === null &&
        credited === null &&
        estCost === null
      ) {
        scaffoldRows += 1;
        continue;
      }

      const dateCell = at(row, cols.date);
      const rawDate = text(dateCell);
      // A date is kept ONLY when the cell held a real date in a plausible range.
      // The live file contains "09/16 or 17" (deliberately ambiguous — the
      // operator did not know which day), "Jan.14" (no year), "Jan", the typo
      // "1/14/202601", and one 1900-01-14 Excel epoch artefact whose real date
      // is written inside the issue text. Guessing any of those would invent a
      // date the operator did not record.
      const eventDate =
        dateCell?.date && dateCell.date >= EARLIEST_PLAUSIBLE && dateCell.date < LATEST_PLAUSIBLE
          ? dateCell.date
          : null;

      const dedupKey = [rawDate ?? '', issue ?? '', actualCost ?? '', credited ?? ''].join('|');

      const prior = seen.get(dedupKey);
      if (prior !== undefined) {
        // The same event on a second sheet. Dropping it is what keeps the money
        // total honest; counting it is what would double $77k into $154k.
        duplicatesRemoved += 1;
        duplicateSources.add(sheet.name);
        continue;
      }
      seen.set(dedupKey, sheet.name);

      rows.push({
        rowIndex: r + 1,
        sheetName: sheet.name,
        eventDate,
        eventDateRaw: rawDate,
        timeRaw: text(at(row, cols.time)),
        issue,
        measuresTaken: measures,
        estimatedTimeCost: text(at(row, cols.estTimeCost)),
        estimatedCost: estCost,
        notes: text(at(row, cols.notes)),
        actualRepairCost: actualCost,
        amountCredited: credited,
        dedupKey,
      });
      eventsFound += 1;
    }

    outcomes.push({
      sheetName: sheet.name,
      skipped: null,
      headerRowIndex: detected.headerRowIndex,
      eventsFound,
      scaffoldRows,
      exampleRows,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({
      estimatedCost: acc.estimatedCost + (r.estimatedCost ?? 0),
      actualRepairCost: acc.actualRepairCost + (r.actualRepairCost ?? 0),
      amountCredited: acc.amountCredited + (r.amountCredited ?? 0),
    }),
    { estimatedCost: 0, actualRepairCost: 0, amountCredited: 0 },
  );

  return {
    rows,
    sheets: outcomes,
    duplicatesRemoved,
    duplicateSources: [...duplicateSources],
    undatedEvents: rows.filter((r) => r.eventDate === null).length,
    totals,
  };
}
