// ADR-0104 §D2/§D3 — the outbound weight-audit extractor.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THIS FILE EXISTS BECAUSE 4,673 LOADS HAVE NO WEIGHT                       │
// │                                                                           │
// │ `mymrc_outbound_mirror` holds 4,673 outbound shipments and `weight_lbs`   │
// │ is NULL on every one of them. "Woodland Outbound Auditing 2026.xlsx" is a │
// │ MyMRC report export carrying that missing figure, per commodity, per      │
// │ load, for 831 Woodland loads (Jan–Jun 2026). The join key is              │
// │ `Materials: Materials ID`, which is UNIQUE-indexed on the mirror.         │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── WORKBOOK-LEVEL, not per-sheet, and that is FORCED by the data ──────────
// This takes the `terex-extract.ts` shape (every sheet at once, one result) and
// NOT the `commodity-extract.ts` shape (one result per sheet). The duplication
// in this workbook is CROSS-SHEET, so a per-sheet extractor structurally cannot
// see it. Measured against the live bytes 2026-08-15 — 16 sheets, 11 of which
// carry both required headers:
//
//     "Outbound Feb 2026"   n "Feb2026 outbounds"       = 113 IDENTICAL SET
//     "Outbound Mar 2026"   n "Mar2026 Outbound"        = 135 IDENTICAL SET
//     "May2026 Outbounds"   n "May2026_Outbounds"       = 139 IDENTICAL SET
//     "April2026 Outbounds" n "April2026 Outbounds (2)" = 158 IDENTICAL SET
//     "Outbound Jan 2026"   n "xtraction (2)"           =  11 (a=131 b=11 subset)
//
// 556 of 1,387 candidate rows are the same load a second time. A per-sheet
// absorber that trusted sheet names would report roughly 1.67x the real
// outbound tonnage — the ADR-0077 class ($231,203.82 reported for a $77,067.94
// document), reproduced on weights instead of dollars.
//
// The duplicates are not sloppy re-keying: they are the same rows pasted with
// different formatting, which is why `Outbound Feb 2026` stores its shipment
// dates as real Excel `Date` objects while `Feb2026 outbounds` stores the serial
// `46055` for the same shipment.
//
// ── THE SIGN TRAP ──────────────────────────────────────────────────────────
// The last column of every monthly sheet is `Total Outbound Materials Weight`.
// It is the NEGATION of the real figure. Measured on `Outbound Feb 2026`:
//
//     sum(Total Outbound Weight)           =  763813
//     sum(Total Outbound Materials Weight) = -763813
//     sum(commodity parts)                 =  763813
//
// `Total Outbound Weight` is the per-load figure and it reconciles to the sum of
// the 13 commodity columns EXACTLY — 0 drift on 831 of 831 distinct loads. An
// extractor that picked the right-most, most authoritative-sounding column would
// ingest every weight in the operation with the wrong sign, and because it is
// internally consistent nothing downstream would look wrong until a total was
// compared against reality. So the check column is captured, asserted, and never
// read as a weight.
//
// ── NEVER THROWS ───────────────────────────────────────────────────────────
// A sheet that cannot be read is REPORTED with a reason, not raised. Pure — no
// exceljs here; `Cell[][]` comes in, so the whole thing is testable against
// hand-written fixtures built from the real header shapes.

import { HEADER_SCAN_ROWS } from './header-detect';
import type { Cell } from './trailer-extract';

/**
 * The commodity column stems, EXACTLY as the workbook writes them.
 *
 * The weight column is `<stem> (lbs)`. The disposition column is
 * `<stem> Disposition` — except `Whole Mattresses and Foundations`, whose
 * disposition header is `Whole Mattresses/Foundations Disposition`. That one is
 * handled explicitly below rather than regexed around: a rule loose enough to
 * match both is loose enough to match the wrong column on the next workbook.
 */
export const COMMODITY_STEMS = [
  'Cardboard',
  'Cotton',
  'Foam',
  'Natural Fiber',
  'Plastics',
  'Quilt and Toppers',
  'Shoddy/Felt',
  'Steel',
  'Synthetic Fiber',
  'Waste',
  'Wood',
  'Whole Mattresses and Foundations',
  'Other',
] as const;

/** Both are required for a sheet to be a candidate at all (§D3). */
const REQUIRED_HEADERS = ['Materials: Materials ID', 'Shipment Date'] as const;

/** Per-row tolerance, in pounds, for the two arithmetic assertions. */
const WEIGHT_TOLERANCE_LBS = 1;

export interface OutboundCommodity {
  /** VERBATIM stem. Not normalised — the vocabulary is data, not schema. */
  commodity: string;
  /** The cell as a number. A recorded 0 is KEPT as 0. */
  weightLbs: number;
  disposition: string | null;
}

export interface OutboundLoad {
  /** `Materials: Materials ID`, e.g. "M-160053". The mirror join key. */
  externalMaterialsId: string;
  bolId: string | null;
  /** Absent on both April sheets. NEVER the source of site. */
  accountNameRaw: string | null;
  materialsStatus: string | null;
  materialsRecordType: string | null;
  /** Only when the cell resolved to a real, plausible date. */
  shipmentDateISO: string | null;
  /** ALWAYS what the cell said — a Date, a serial, or free text. */
  shipmentDateRaw: string | null;
  /** From `Total Outbound Weight`. NEVER from the check column. */
  totalWeightLbs: number | null;
  /** From `Total Outbound Materials Weight` — its negation. Never a weight. */
  totalWeightCheckLbs: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  sheetName: string;
  rowIndex: number;
  commodities: OutboundCommodity[];
}

export type OutboundSheetSkip =
  /** No row in the scan window carried both required headers. */
  | 'not_an_outbound_sheet';

export interface OutboundSheetOutcome {
  sheetName: string;
  skipped: OutboundSheetSkip | null;
  /** 1-based, matching how Excel and a human count. 0 when none was found. */
  headerRowIndex: number;
  /** Rows that yielded a Materials ID, BEFORE cross-sheet de-duplication. */
  rowsSeen: number;
  /** Rows that survived de-duplication and became loads. */
  loadsFound: number;
  /** Which required headers were absent — the reason, not just the refusal. */
  missingHeaders: string[];
}

export interface OutboundExtractFailure {
  kind: 'no_candidate_sheets' | 'no_loads';
  message: string;
}

export interface OutboundExtractResult {
  loads: OutboundLoad[];
  sheets: OutboundSheetOutcome[];
  /** Loads dropped because an earlier sheet already carried them. */
  duplicatesRemoved: number;
  /** `M-160053 also on "Feb2026 outbounds"` — one per drop, for the preview. */
  duplicateSources: string[];
  /** Materials IDs where `check != -total` beyond tolerance. */
  signCheckFailures: string[];
  /** Materials IDs where the commodity parts do not sum to the total. */
  partsCheckFailures: string[];
  totals: { totalWeightLbs: number; commodityRows: number };
  failure: OutboundExtractFailure | null;
}

/** Collapse a header to a comparable form: no case, no runs of whitespace. */
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

/** A blank cell is NOT RECORDED, never 0. A non-numeric cell is not a number. */
function num(c: Cell | null): number | null {
  if (c === null || c.text.trim() === '') return null;
  return c.num ?? null;
}

/**
 * Excel serial day -> ISO date.
 *
 * Excel's epoch is anchored so that serial 1 is 1900-01-01, but it also carries
 * the Lotus-compatibility bug of treating 1900 as a leap year. For every serial
 * this workbook contains (all 2025-2026, i.e. > 45000) the correct anchor is
 * therefore 1899-12-30. Serials at or below 60 fall inside the buggy region and
 * are REFUSED rather than shifted by a day — a shipment "dated" 1900-02-28 is
 * not a shipment, and guessing which side of the artefact it belongs on would
 * invent a date the operator never wrote.
 *
 * Neither `toCell` nor `trailer-extract.ts` does this: `toCell` returns a serial
 * as `num` and a text date as `text`, and the trailer extractor only ever reads
 * `cell.date`. 270 of this workbook's 831 loads carry a serial or a text date,
 * so the conversion has to live somewhere and this is the only reader of it.
 */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 60) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * `M/D/YYYY` text -> ISO.
 *
 * US month-first, which is not an assumption: the live January sheet writes
 * `1/19/2026`, and 19 cannot be a month. A value whose parts do not form a real
 * calendar date returns null and the raw text survives in `shipmentDateRaw`.
 */
export function usDateTextToISO(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip guard: Date.UTC silently rolls 2026-02-31 into 2026-03-03.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** All three shapes the `Shipment Date` column arrives in, in one place. */
function resolveShipmentDate(c: Cell | null): { iso: string | null; raw: string | null } {
  if (c === null || c.text.trim() === '') return { iso: null, raw: null };
  const raw = c.text.trim();
  if (c.date !== null) return { iso: c.date, raw };
  if (c.num !== null) return { iso: excelSerialToISO(c.num), raw };
  return { iso: usDateTextToISO(raw), raw };
}

interface SheetHeader {
  headerRowIndex: number;
  headers: string[];
  missing: string[];
}

/**
 * Find the row that carries BOTH required headers.
 *
 * Deliberately a scan rather than `detectHeaderRow`'s single best guess. The
 * measured header rows in this workbook are 1, 2, 4 and 10, and the candidacy
 * test IS "does a row in the scan window carry both of these labels" — asking
 * that question directly is both the contract and the cheaper thing to falsify.
 */
function findHeaderRow(cells: Cell[][]): SheetHeader {
  let best: SheetHeader = { headerRowIndex: 0, headers: [], missing: [...REQUIRED_HEADERS] };
  const scan = Math.min(HEADER_SCAN_ROWS, cells.length);
  for (let r = 0; r < scan; r += 1) {
    const row = cells[r];
    if (!row) continue;
    const headers = row.map((c) => c.text.trim());
    const normed = headers.map(norm);
    const missing = REQUIRED_HEADERS.filter((h) => !normed.includes(norm(h)));
    if (missing.length === 0) return { headerRowIndex: r + 1, headers, missing: [] };
    // Keep the closest near-miss so a refusal can say WHICH header was absent
    // rather than only that the sheet was not recognised.
    if (missing.length < best.missing.length) {
      best = { headerRowIndex: r + 1, headers, missing };
    }
  }
  return best;
}

/**
 * Extract every outbound load in the workbook, de-duplicated across sheets.
 *
 * `collected` is every sheet in WORKBOOK ORDER. That order is the tie-break
 * rule: the first sheet to yield a given Materials ID wins and every later
 * occurrence is dropped, counted, and named. Because the four duplicate pairs
 * are equal in content, which one wins does not change a figure today — but a
 * rule that depends on which one wins is a rule that will change a figure later.
 */
export function extractOutboundRows(
  collected: { name: string; cells: Cell[][] }[],
): OutboundExtractResult {
  const sheets: OutboundSheetOutcome[] = [];
  const loads: OutboundLoad[] = [];
  /** Materials ID -> the sheet that claimed it. */
  const seen = new Map<string, string>();
  const duplicateSources: string[] = [];
  const signCheckFailures: string[] = [];
  const partsCheckFailures: string[] = [];
  let duplicatesRemoved = 0;
  let candidates = 0;

  for (const sheet of collected) {
    const detected = findHeaderRow(sheet.cells);
    if (detected.missing.length > 0) {
      // The five pivot sheets (`Foam_Topper`, `Wood`, `steel`, `trash`, `other`)
      // land here, and they are refused DELIBERATELY: they carry `$/ton`,
      // `total cost`, `gross profit` and `net profit`, they are recomputable
      // from the load rows, and importing a derived margin as a fact is how a
      // spreadsheet's arithmetic becomes the system's opinion.
      sheets.push({
        sheetName: sheet.name,
        skipped: 'not_an_outbound_sheet',
        headerRowIndex: detected.headerRowIndex,
        rowsSeen: 0,
        loadsFound: 0,
        missingHeaders: detected.missing,
      });
      continue;
    }
    candidates += 1;

    const normed = detected.headers.map(norm);
    const col = (label: string): number => normed.indexOf(norm(label));
    const matCol = col('Materials: Materials ID');
    const shipCol = col('Shipment Date');
    const totalCol = col('Total Outbound Weight');
    const checkCol = col('Total Outbound Materials Weight');
    const bolCol = col('BOL ID');
    const acctCol = col('Account Name');
    const statusCol = col('Materials Status');
    const typeCol = col('Materials: Record Type');
    const progCol = col('Number of Program Units');
    const nonProgCol = col('Number of Non-Program Units');

    // Resolved ONCE per sheet, by header text. `Column1`/`Column2` filler
    // columns appear and disappear between sheets and `xtraction (2)` carries
    // only two of the thirteen commodities, so an offset-based mapping would
    // silently read the wrong column rather than fail.
    const commodityCols = COMMODITY_STEMS.map((stem) => ({
      stem,
      weight: col(`${stem} (lbs)`),
      disposition: col(
        stem === 'Whole Mattresses and Foundations'
          ? 'Whole Mattresses/Foundations Disposition'
          : `${stem} Disposition`,
      ),
    })).filter((c) => c.weight >= 0);

    let rowsSeen = 0;
    let loadsFound = 0;

    for (let r = detected.headerRowIndex; r < sheet.cells.length; r += 1) {
      const row = sheet.cells[r];
      if (!row) continue;
      const matId = text(at(row, matCol));
      if (matId === null) continue;
      // A repeated header row inside the body is not a load.
      if (norm(matId) === norm('Materials: Materials ID')) continue;
      rowsSeen += 1;

      const prior = seen.get(matId);
      if (prior !== undefined) {
        duplicatesRemoved += 1;
        duplicateSources.push(`${matId} also on "${prior}"`);
        continue;
      }
      seen.set(matId, sheet.name);

      const totalWeightLbs = num(at(row, totalCol));
      const totalWeightCheckLbs = num(at(row, checkCol));
      if (
        totalWeightLbs !== null &&
        totalWeightCheckLbs !== null &&
        Math.abs(totalWeightCheckLbs + totalWeightLbs) > WEIGHT_TOLERANCE_LBS
      ) {
        signCheckFailures.push(matId);
      }

      const commodities: OutboundCommodity[] = [];
      let parts = 0;
      for (const c of commodityCols) {
        const weightLbs = num(at(row, c.weight));
        if (weightLbs === null) continue;
        parts += weightLbs;
        commodities.push({
          commodity: c.stem,
          weightLbs,
          disposition: text(at(row, c.disposition)),
        });
      }
      // Catches a commodity column added to the workbook that this extractor
      // does not know about: the parts would no longer reach the total.
      if (totalWeightLbs !== null && Math.abs(parts - totalWeightLbs) > WEIGHT_TOLERANCE_LBS) {
        partsCheckFailures.push(matId);
      }

      const ship = resolveShipmentDate(at(row, shipCol));
      loads.push({
        externalMaterialsId: matId,
        bolId: text(at(row, bolCol)),
        accountNameRaw: text(at(row, acctCol)),
        materialsStatus: text(at(row, statusCol)),
        materialsRecordType: text(at(row, typeCol)),
        shipmentDateISO: ship.iso,
        shipmentDateRaw: ship.raw,
        totalWeightLbs,
        totalWeightCheckLbs,
        programUnits: num(at(row, progCol)),
        nonProgramUnits: num(at(row, nonProgCol)),
        sheetName: sheet.name,
        rowIndex: r + 1,
        commodities,
      });
      loadsFound += 1;
    }

    sheets.push({
      sheetName: sheet.name,
      skipped: null,
      headerRowIndex: detected.headerRowIndex,
      rowsSeen,
      loadsFound,
      missingHeaders: [],
    });
  }

  const totals = {
    totalWeightLbs: loads.reduce((a, l) => a + (l.totalWeightLbs ?? 0), 0),
    commodityRows: loads.reduce((a, l) => a + l.commodities.length, 0),
  };

  let failure: OutboundExtractFailure | null = null;
  if (candidates === 0) {
    failure = {
      kind: 'no_candidate_sheets',
      message:
        `No sheet carried both "${REQUIRED_HEADERS[0]}" and "${REQUIRED_HEADERS[1]}" in its ` +
        `first ${HEADER_SCAN_ROWS} rows. Sheets present: ` +
        `${collected.map((s) => `"${s.name}"`).join(', ') || '(none)'}.`,
    };
  } else if (loads.length === 0) {
    failure = {
      kind: 'no_loads',
      message:
        `${candidates} sheet(s) carried the outbound headers but not one row held a ` +
        `"${REQUIRED_HEADERS[0]}".`,
    };
  }

  return {
    loads,
    sheets,
    duplicatesRemoved,
    duplicateSources,
    signCheckFailures,
    partsCheckFailures,
    totals,
    failure,
  };
}
