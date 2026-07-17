// ADR-0048/0049 §8.2 — semantic-section extractors for the REAL Woodland
// daily-log workbooks.
//
// WHY this exists: the ADR-0039 parser (parser.ts) addressed sheets by EXACT
// lowercase name ('summary'/'inbound'/'outbound'/'inventory'). The real Woodland
// workbooks carry none of those sheets, so that parser returned 0 staging rows
// and templateGeneration='unknown'. This module drives extraction off the
// `classifyWorkbookSheets` SEMANTIC TYPE instead, and emits StagingRows whose
// `section` + `raw_value` JSON payload match the ADR-0048 promotion decode
// contract (`workbook-promotion.ts` `decodeStagingRows`), so the SAME staging
// rows the operator reviews are the rows the promotion later consumes.
//
// Layout facts are drawn from the real June + July files (verified §8.2):
//   - inb_trans_charges / inb_no_trans_charge : header row w/ Date+Site+"inbound
//     unit #"; each data row = one inbound load.
//   - nonprogram : non-program INBOUND loads (Date/Site/"inbound unit #"/…). NOTE
//     the promotion feeds these to inbound_loads as NON-program units, not
//     outbound — see the FLAG emitted at runtime.
//   - incentive_unpaid : two side-by-side blocks (INCENTIVE | UNPAID drop-off) =
//     consumer_dropoffs.
//   - processed : per-day close ("Day 1".."Day 31") w/ stripped program/non-prog
//     + material ticket = processed_units_daily. Opening balance = program begin.
//   - DAY0..DAY31 : the AUTHORITATIVE per-shipment outbound grid (below an
//     "OUTBOUNDS" marker; 8 commodity blocks + DAY6's 9th COTTON block).
//   - commodities / renovation / all : the SAME outbound shipments rolled up —
//     staged as EVIDENCE only (section 'detail') so the promotion never
//     double-counts them against the DAY grid.
//
// Every ambiguous or billing-affecting mapping decision is recorded in `flags`
// (surfaced in the parse result) rather than silently guessed.

import type ExcelJS from 'exceljs';
import { cellText, cellNumber } from './cells';
import type { WorksheetSemanticType } from './section-resolver';
import { OUTBOUND_BLOCK_LABELS } from './day-sheet-layout';
import type { Commodity } from '../types';
import type {
  CellProvenance,
  InboundStage,
  OutboundStage,
  StagingRow,
  SummaryFigure,
} from './parser';

// ── column helpers ────────────────────────────────────────────────────────

/** 1 → 'A', 27 → 'AA'. */
export function numberToColumnLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function norm(t: string | null | undefined): string {
  return (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 1-based column of the first header cell matching `re`, or null. */
function findCol(headers: (string | null)[], re: RegExp): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] != null && re.test(headers[i]!)) return i + 1;
  }
  return null;
}

/** Read a whole row (1-based, up to `cols`) as coerced text. */
function rowTexts(ws: ExcelJS.Worksheet, r: number, cols: number): (string | null)[] {
  const row = ws.getRow(r);
  const out: (string | null)[] = [];
  for (let c = 1; c <= cols; c++) out.push(cellText(row.getCell(c).value));
  return out;
}

/** A cell Date coerced to 'YYYY-MM-DD', or null when it is not a real date. */
function isoDay(value: ExcelJS.CellValue): string | null {
  const t = cellText(value);
  if (t === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m ? m[1]! : null;
}

const widest = (ws: ExcelJS.Worksheet): number => Math.max(ws.columnCount || 0, 12);

// ── accumulator ───────────────────────────────────────────────────────────

export interface DayInventory {
  day: number;
  start: number | null;
  end: number | null;
  inbound: number | null;
  processed: number | null;
}

export interface ExtractionResult {
  stagingRows: StagingRow[];
  inbound: InboundStage[];
  outbound: OutboundStage[];
  summaryFigures: SummaryFigure[];
  /** Opening physical inventory (program begin balance), if found. */
  opening: { unitsTotal: number; provenance: CellProvenance } | null;
  /**
   * The AUTHORITATIVE month-close on-hand whole-unit balance, read from the
   * workbook's OWN computed "Ending inventory" cell on the last DAY sheet — NOT
   * recomputed from flows. This is the figure the operator compares (June's
   * real value re-derives to 4062; July to 2577).
   */
  closeBalance: { value: number; provenance: CellProvenance } | null;
  /** Per-day inventory/inbound/processed parity series (from the DAY summary boxes). */
  inventorySeries: DayInventory[];
  /** Sum of complete per-day INBOUND (all channels) — reconciles to the close. */
  workbookInboundTotal: number | null;
  /** Per-section row counts for the operator report. */
  counts: Record<string, number>;
  /** Billing-affecting / ambiguity flags for operator review. */
  flags: string[];
}

function emptyResult(): ExtractionResult {
  return {
    stagingRows: [],
    inbound: [],
    outbound: [],
    summaryFigures: [],
    opening: null,
    closeBalance: null,
    inventorySeries: [],
    workbookInboundTotal: null,
    counts: {},
    flags: [],
  };
}

function bump(counts: Record<string, number>, key: string, n = 1): void {
  counts[key] = (counts[key] ?? 0) + n;
}

// ── inbound (DAY per-day INBOUND grid — the COMPLETE all-channel inbound) ───
//
// Each DAY sheet carries a per-day INBOUND grid near the top: a header row with
// Date + Site + "inbound unit #", data rows below it, bounded above the OUTBOUND
// single-list ("sub category" header) / the OUTBOUNDS multi-block marker. Every
// inbound row lands here — B2B hauls AND consumer drop-offs — and the sum equals
// the workbook's own computed per-day "INBOUND" total (verified: June 19765,
// July 8822). The `commodity` column classifies the channel:
//   "inbound units"            → inbound_loads
//   "unpaid consumer drop off" → consumer_dropoffs (unpaid)
//   "incentive drop off"       → consumer_dropoffs (incentive)
//   "illegal drop off"         → consumer_dropoffs (illegal)
// This is the AUTHORITATIVE inbound source (§8.2 inbound-sourcing fix). The
// category sheets (inb_trans / inb_no_trans / nonprogram / incentive_unpaid) are
// billing re-categorizations of the SAME rows — staged as evidence, never
// promoted, to avoid double-counting.

function findDayInboundHeader(
  ws: ExcelJS.Worksheet,
): { row: number; date: number; site: number; commodity: number; units: number } | null {
  const cols = widest(ws);
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const h = rowTexts(ws, r, cols);
    const date = findCol(h, /^date$/i);
    const site = findCol(h, /^site$/i);
    const units = findCol(h, /inbound\s*unit\s*#/i);
    const commodity = findCol(h, /^commodity$/i);
    if (date && site && units && commodity) return { row: r, date, site, commodity, units };
  }
  return null;
}

const DROPOFF_CHANNEL: readonly { re: RegExp; kind: 'unpaid' | 'incentive' | 'illegal' }[] = [
  { re: /unpaid/i, kind: 'unpaid' },
  { re: /incentive/i, kind: 'incentive' },
  { re: /illegal/i, kind: 'illegal' },
];

function extractDayInbound(ws: ExcelJS.Worksheet, res: ExtractionResult): void {
  const hdr = findDayInboundHeader(ws);
  if (!hdr) return; // DAY0-style template rows without a populated inbound grid
  // Lower bound: the OUTBOUND single-list ("sub category") header, else the
  // OUTBOUNDS multi-block marker, else end of sheet.
  const cols = widest(ws);
  let boundary = ws.rowCount + 1;
  for (let r = hdr.row + 1; r <= Math.min(ws.rowCount, 60); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= cols; c++) {
      const t = norm(cellText(row.getCell(c).value));
      if (t === 'sub category' || t === 'outbounds') {
        boundary = r;
        break;
      }
    }
    if (boundary !== ws.rowCount + 1) break;
  }

  let nLoad = 0;
  let nDrop = 0;
  for (let r = hdr.row + 1; r < boundary; r++) {
    const row = ws.getRow(r);
    const date = isoDay(row.getCell(hdr.date).value);
    if (date === null) continue;
    const units = cellNumber(row.getCell(hdr.units).value);
    if (units === null) continue;
    const site = cellText(row.getCell(hdr.site).value) ?? 'Unknown';
    const channel = norm(cellText(row.getCell(hdr.commodity).value));
    const dropoff = DROPOFF_CHANNEL.find((d) => d.re.test(channel));
    const unitsInt = Math.round(units);
    const colRef = numberToColumnLetter(hdr.units);
    const prov: CellProvenance = { tab: ws.name, row: r, col: colRef };

    if (dropoff) {
      res.stagingRows.push({
        tabName: ws.name,
        rowIndex: r,
        colRef,
        section: 'dropoff',
        fieldKey: dropoff.kind,
        rawValue: JSON.stringify({ date, kind: dropoff.kind, personName: site, units: unitsInt }),
        numericValue: unitsInt,
        siteNameRaw: site,
        provenance: prov,
      });
      nDrop++;
    } else {
      res.inbound.push({
        siteNameRaw: site,
        sourceType: 'day_inbound',
        units: unitsInt,
        provenance: prov,
      });
      res.stagingRows.push({
        tabName: ws.name,
        rowIndex: r,
        colRef,
        section: 'inbound',
        fieldKey: 'inbound_units',
        rawValue: JSON.stringify({
          date,
          sourceNameRaw: site,
          units: unitsInt,
          loadSourceType: 'b2b_haul',
        }),
        numericValue: unitsInt,
        siteNameRaw: site,
        provenance: prov,
      });
      nLoad++;
    }
  }
  bump(res.counts, 'inbound_day_loads', nLoad);
  bump(res.counts, 'dropoff_day', nDrop);
}

// ── outbound (DAY sheets — authoritative per-shipment grid) ────────────────

const LABEL_TO_COMMODITY: ReadonlyMap<string, Commodity> = new Map(
  OUTBOUND_BLOCK_LABELS.map((l) => [l.label, l.commodity]),
);

function findOutboundGridRow(ws: ExcelJS.Worksheet): number | null {
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= 6; c++) {
      if (norm(cellText(row.getCell(c).value)) === 'outbounds') return r;
    }
  }
  return null;
}

function extractDayOutbound(ws: ExcelJS.Worksheet, res: ExtractionResult): void {
  const gridRow = findOutboundGridRow(ws);
  if (gridRow === null) {
    res.flags.push(`[outbound] ${ws.name}: no "OUTBOUNDS" grid marker found — 0 rows`);
    return;
  }
  const labelRow = gridRow + 1;
  const dataStart = gridRow + 3; // marker, block-labels, field-headers, then data
  const cols = widest(ws);
  const labels = rowTexts(ws, labelRow, cols);

  // Locate each commodity block by its label cell → block startCol = that col.
  const blocks: { commodity: Commodity; startCol: number }[] = [];
  for (let c = 0; c < labels.length; c++) {
    const key = norm(labels[c]);
    const commodity = LABEL_TO_COMMODITY.get(key);
    if (commodity) blocks.push({ commodity, startCol: c + 1 });
  }
  if (blocks.length === 0) {
    res.flags.push(`[outbound] ${ws.name}: OUTBOUNDS grid found but no commodity block labels`);
    return;
  }

  let n = 0;
  for (const b of blocks) {
    // fields: Date=+0 Site=+1 Commodity=+2 Weight=+3 BOL=+4 DR3=+5 Ticket=+6
    for (let r = dataStart; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const date = isoDay(row.getCell(b.startCol).value);
      if (date === null) continue;
      const weight = cellNumber(row.getCell(b.startCol + 3).value);
      if (weight === null || weight <= 0) continue; // skip placeholder/zero rows
      const site = cellText(row.getCell(b.startCol + 1).value);
      const bol = cellText(row.getCell(b.startCol + 4).value);
      const ticket = cellText(row.getCell(b.startCol + 6).value);
      const colRef = numberToColumnLetter(b.startCol + 3);
      const prov: CellProvenance = { tab: ws.name, row: r, col: colRef };
      const weightLbs = Math.round(weight);

      res.outbound.push({
        commodity: b.commodity,
        subCategory: null,
        weightLbs,
        provenance: prov,
      });
      const payload: Record<string, unknown> = {
        date,
        commodity: b.commodity,
        subCategory: 'baled', // DAY grid carries no sub-category; 'baled' is
        // balance-neutral (only 'renovation' rows affect the unit close). FLAG.
        weightLbs,
      };
      if (ticket) payload['ticketNumber'] = ticket;
      if (bol) payload['bolNumber'] = bol;
      if (site) payload['buyer'] = site;
      res.stagingRows.push({
        tabName: ws.name,
        rowIndex: r,
        colRef,
        section: 'outbound',
        fieldKey: b.commodity,
        rawValue: JSON.stringify(payload),
        numericValue: weightLbs,
        siteNameRaw: site,
        provenance: prov,
      });
      n++;
    }
  }
  bump(res.counts, 'outbound_day_total', n);
}

// ── processed (daily close + opening balance) ──────────────────────────────

function extractProcessed(ws: ExcelJS.Worksheet, monthPrefix: string, res: ExtractionResult): void {
  const cols = widest(ws);
  // Opening program balance: the number immediately LEFT of the "Program" label
  // in the "Begining Balances" band (rows 4–6).
  for (let r = 3; r <= 7 && res.opening === null; r++) {
    const h = rowTexts(ws, r, cols);
    const progCol = findCol(h, /^program$/i);
    if (progCol && progCol >= 2) {
      const v = cellNumber(ws.getRow(r).getCell(progCol - 1).value);
      if (v !== null) {
        res.opening = {
          unitsTotal: Math.round(v),
          provenance: { tab: ws.name, row: r, col: numberToColumnLetter(progCol - 1) },
        };
      }
    }
  }

  // Daily rows: col2 = "Day N"; stripped program (col4) / non-program (col5);
  // material ticket (col10). Columns are stable across June & July.
  const STRIPPED_PROGRAM = 4;
  const STRIPPED_NONPROG = 5;
  const MATERIAL = 10;
  let n = 0;
  for (let r = 1; r <= ws.rowCount; r++) {
    const dayText = cellText(ws.getRow(r).getCell(2).value);
    const dm = dayText ? /^day\s*(\d{1,2})$/i.exec(dayText.trim()) : null;
    if (!dm) continue;
    const day = parseInt(dm[1]!, 10);
    if (day < 1 || day > 31) continue;
    const row = ws.getRow(r);
    const sp = cellNumber(row.getCell(STRIPPED_PROGRAM).value);
    const snp = cellNumber(row.getCell(STRIPPED_NONPROG).value);
    if (sp === null && snp === null) continue; // no processing recorded that day
    const date = `${monthPrefix}-${String(day).padStart(2, '0')}`;
    const material = cellText(row.getCell(MATERIAL).value);
    const prov: CellProvenance = {
      tab: ws.name,
      row: r,
      col: numberToColumnLetter(STRIPPED_PROGRAM),
    };
    const payload: Record<string, unknown> = {
      date,
      strippedProgram: sp ?? 0,
      strippedNonProgram: snp ?? 0,
    };
    if (material && /\d/.test(material)) payload['materialTicketNumber'] = material;
    res.stagingRows.push({
      tabName: ws.name,
      rowIndex: r,
      colRef: prov.col,
      section: 'daily_close',
      fieldKey: `day_${day}`,
      rawValue: JSON.stringify(payload),
      numericValue: sp ?? 0,
      siteNameRaw: null,
      provenance: prov,
    });
    n++;
  }
  bump(res.counts, 'processed_daily_close', n);
  if (n > 0) {
    res.flags.push(
      `[processed] ${ws.name}: dates built from "Day N" + workbook month ${monthPrefix} (sheet has no ISO date column). Stripped program=col D, non-program=col E, ticket=col J. CONFIRM month + columns.`,
    );
  }
}

// ── real billing Summary → best-effort figures (feed recomputeSummary) ─────

function extractSummary(ws: ExcelJS.Worksheet, res: ExtractionResult): void {
  let n = 0;
  // Label/value pairs in the two summary columns (label col, value one col right).
  for (const labelCol of [2, 10]) {
    for (let r = 1; r <= ws.rowCount; r++) {
      const label = cellText(ws.getRow(r).getCell(labelCol).value);
      if (label === null || !/[a-z]/i.test(label)) continue;
      const value = cellNumber(ws.getRow(r).getCell(labelCol + 1).value);
      if (value === null) continue;
      const colRef = numberToColumnLetter(labelCol + 1);
      const prov: CellProvenance = { tab: ws.name, row: r, col: colRef };
      const key = `${labelCol === 2 ? 'mid' : 'month'}:${label}`;
      res.summaryFigures.push({
        key,
        storedValue: value,
        detailSheet: null,
        detailColumn: null,
        rangeFirstRow: null,
        rangeLastRow: null,
        provenance: prov,
      });
      res.stagingRows.push({
        tabName: ws.name,
        rowIndex: r,
        colRef,
        section: 'summary',
        fieldKey: key,
        rawValue: String(value),
        numericValue: value,
        siteNameRaw: null,
        provenance: prov,
      });
      n++;
    }
  }
  bump(res.counts, 'summary_figures', n);
}

// ── evidence-only sheets (staged, promotion-skipped, counted for the report) ─

function extractEvidence(
  ws: ExcelJS.Worksheet,
  type: WorksheetSemanticType,
  res: ExtractionResult,
): void {
  // A single provenance marker row per evidence sheet keeps staging light while
  // preserving the sheet's existence + a countable footprint. Section 'detail'
  // is in the promotion decode's skip-list, so it never double-counts.
  const cols = widest(ws);
  let dataRows = 0;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (isoDay(ws.getRow(r).getCell(1).value) || isoDay(ws.getRow(r).getCell(2).value)) dataRows++;
  }
  res.stagingRows.push({
    tabName: ws.name,
    rowIndex: 1,
    colRef: 'A',
    section: 'detail',
    fieldKey: `evidence:${type}`,
    rawValue: JSON.stringify({ type, name: ws.name, dataRows, cols }),
    numericValue: dataRows,
    siteNameRaw: null,
    provenance: { tab: ws.name, row: 1, col: 'A' },
  });
  bump(res.counts, `evidence:${type}`, dataRows);
}

// ── authoritative inventory summary (DAY summary boxes) ────────────────────

const DAY_NUM = /^day(\d{1,2})$/i;

/** Value for a label cell: first number to its right (same row), else one below. */
function labelValue(ws: ExcelJS.Worksheet, r: number, c: number): number | null {
  for (let cc = c + 1; cc <= c + 3; cc++) {
    const v = cellNumber(ws.getRow(r).getCell(cc).value);
    if (v !== null) return v;
  }
  return cellNumber(ws.getRow(r + 1).getCell(c).value);
}

/**
 * Read each DAY sheet's computed summary box (Starting/Ending inventory, INBOUND,
 * Processed). The close balance is the Ending inventory of the highest-numbered
 * DAY sheet that carries one (DAY31 forwards the last real day). These are the
 * workbook's OWN formula outputs — authoritative parity figures.
 */
function extractInventory(
  wb: ExcelJS.Workbook,
  classification: Map<string, WorksheetSemanticType>,
  res: ExtractionResult,
): void {
  const series: DayInventory[] = [];
  let inboundTotal = 0;
  let sawInbound = false;
  for (const ws of wb.worksheets) {
    if (classification.get(ws.name) !== 'day') continue;
    const m = DAY_NUM.exec(ws.name.trim());
    if (!m) continue;
    const day = parseInt(m[1]!, 10);
    const cols = widest(ws);
    const inv: DayInventory = { day, start: null, end: null, inbound: null, processed: null };
    // Labels sit within the top ~50 rows; scan for them.
    for (let r = 1; r <= Math.min(ws.rowCount, 50); r++) {
      const h = ws.getRow(r);
      for (let c = 1; c <= cols; c++) {
        const t = norm(cellText(h.getCell(c).value));
        if (t === 'starting inventory') inv.start ??= labelValue(ws, r, c);
        else if (t === 'ending inventory') inv.end ??= labelValue(ws, r, c);
        else if (t === 'inbound' || t === 'inbound all') inv.inbound ??= labelValue(ws, r, c);
        else if (t === 'processed') inv.processed ??= labelValue(ws, r, c);
      }
    }
    if (inv.inbound !== null) {
      inboundTotal += inv.inbound;
      sawInbound = true;
    }
    series.push(inv);
  }
  series.sort((a, b) => a.day - b.day);
  res.inventorySeries = series;
  // Close = ending inventory of the highest-numbered day that has one.
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i]!.end !== null) {
      const day = series[i]!.day;
      const ws = wb.worksheets.find((w) => DAY_NUM.exec(w.name.trim())?.[1] === String(day));
      res.closeBalance = {
        value: series[i]!.end!,
        provenance: { tab: ws?.name ?? `DAY${day}`, row: 0, col: 'end_inventory' },
      };
      break;
    }
  }
  res.workbookInboundTotal = sawInbound ? inboundTotal : null;
}

// ── orchestration ──────────────────────────────────────────────────────────

/** Derive a 'YYYY-MM' month prefix from the first dated inbound row seen. */
function deriveMonthPrefix(res: ExtractionResult): string | null {
  for (const row of res.stagingRows) {
    if (row.section !== 'inbound' || row.rawValue === null) continue;
    try {
      const d = JSON.parse(row.rawValue) as { date?: string };
      if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) return d.date.slice(0, 7);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Extract every classified sheet into staging rows + structured report data.
 * `classification` is the `classifyWorkbookSheets` output; the caller resolves
 * it once and passes it in so the parser and report share one classification.
 */
export function extractWorkbook(
  wb: ExcelJS.Workbook,
  classification: Map<string, WorksheetSemanticType>,
): ExtractionResult {
  const res = emptyResult();

  // Pass 1 — inbound first (so the month prefix is available for `processed`).
  const processedSheets: ExcelJS.Worksheet[] = [];
  const daySheets: ExcelJS.Worksheet[] = [];
  const deferred: [ExcelJS.Worksheet, WorksheetSemanticType][] = [];

  for (const ws of wb.worksheets) {
    const type = classification.get(ws.name) ?? 'unknown';
    switch (type) {
      case 'processed':
        processedSheets.push(ws);
        break;
      case 'day':
        daySheets.push(ws);
        break;
      case 'summary':
        extractSummary(ws, res);
        break;
      // Inbound + drop-off SOURCING moved to the DAY per-day INBOUND grid (the
      // complete all-channel inbound). The category sheets are the SAME rows
      // re-categorized for billing — staged as evidence, never promoted, to
      // avoid double-counting (§8.2 inbound-sourcing fix).
      case 'inb_trans_charges':
      case 'inb_no_trans_charge':
      case 'nonprogram':
      case 'incentive_unpaid':
      default:
        deferred.push([ws, type]);
    }
  }

  // Pass 2 — DAY inbound (complete) + outbound + processed (needs month prefix).
  for (const ws of daySheets) {
    extractDayInbound(ws, res);
    extractDayOutbound(ws, res);
  }

  // Authoritative inventory summary (close balance + per-day parity series).
  extractInventory(wb, classification, res);
  if (res.closeBalance) {
    const dayLoads = res.counts['inbound_day_loads'] ?? 0;
    const dayDrops = res.counts['dropoff_day'] ?? 0;
    const stagedInbound =
      res.inbound.reduce((s, i) => s + i.units, 0) +
      res.stagingRows
        .filter((r) => r.section === 'dropoff')
        .reduce((s, r) => s + (r.numericValue ?? 0), 0);
    const wbInbound = res.workbookInboundTotal;
    res.flags.push(
      `[close] AUTHORITATIVE month-close on-hand = ${res.closeBalance.value} whole units, read from the workbook's own "Ending inventory" cell on ${res.closeBalance.provenance.tab} (NOT recomputed from flows).`,
    );
    if (wbInbound !== null) {
      const match = stagedInbound === wbInbound;
      res.flags.push(
        `[inbound-sourced-from-DAY-grid] inbound_loads (${dayLoads}) + consumer_dropoffs (${dayDrops}) now sourced from the DAY per-day INBOUND grid = the COMPLETE all-channel inbound. Staged inbound-unit total = ${stagedInbound}; workbook's own per-day INBOUND total = ${wbInbound} — ${match ? 'RECONCILES EXACTLY' : `GAP ${stagedInbound - wbInbound} (INVESTIGATE)`}. Category sheets (inb_trans/inb_no_trans/nonprogram/incentive_unpaid) are the same rows re-categorized for billing — staged as EVIDENCE, not promoted, to avoid double-counting.`,
      );
    }
  }

  const monthPrefix = deriveMonthPrefix(res);
  if (processedSheets.length > 0) {
    if (monthPrefix === null) {
      res.flags.push(
        `[processed] cannot derive workbook month (no dated inbound rows) — processed daily-close rows SKIPPED. CONFIRM.`,
      );
    } else {
      for (const ws of processedSheets) extractProcessed(ws, monthPrefix, res);
    }
  }

  // Opening inventory → an opening_inventory staging row (dated to window open;
  // the promotion re-dates it to just-before the scope, so the calendar day here
  // is only a within-window anchor).
  if (res.opening && monthPrefix) {
    const payload = { date: `${monthPrefix}-01`, unitsTotal: res.opening.unitsTotal };
    res.stagingRows.push({
      tabName: res.opening.provenance.tab,
      rowIndex: res.opening.provenance.row,
      colRef: res.opening.provenance.col,
      section: 'opening_inventory',
      fieldKey: 'opening_program_balance',
      rawValue: JSON.stringify(payload),
      numericValue: res.opening.unitsTotal,
      siteNameRaw: null,
      provenance: res.opening.provenance,
    });
    bump(res.counts, 'opening_inventory', 1);
    res.flags.push(
      `[opening] program begin balance ${res.opening.unitsTotal} from ${res.opening.provenance.tab}!${res.opening.provenance.col}${res.opening.provenance.row} → opening_inventory.unitsTotal. Non-program begin treated as 0. CONFIRM.`,
    );
  }

  // Pass 3 — evidence-only sheets (rollups + reference tabs). commodities/all
  // are the DAY grid rolled up; staging them as promotion-consumable outbound
  // would double-count, so they are evidence.
  for (const [ws, type] of deferred) {
    if (type === 'unknown') {
      res.flags.push(
        `[unmapped] ${ws.name}: classified 'unknown' — staged as evidence, NOT promoted`,
      );
    }
    extractEvidence(ws, type, res);
  }

  return res;
}
