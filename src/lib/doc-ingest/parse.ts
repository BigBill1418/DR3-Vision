// ADR-0067 §3.2 D5/D7 — structural parsing of an ingested document.
//
// Two consumers, one parse:
//   - the CLASSIFIER reads the shape (sheet names, headers, a text sample) to
//     decide what KIND of document this is;
//   - the GUARDRAIL compares this revision's summary against the previous one to
//     decide whether the change is normal or abnormal.
//
// Doing it once matters beyond cost: if the two read the file separately they
// can disagree about what it contains, and then a change can pass the guardrail
// against a structure the classifier never saw.
//
// ── .xlsm (D8, MANDATORY) ───────────────────────────────────────────────────
// The daily logs ARE macro-enabled workbooks, so `.xlsm` support is not
// optional. exceljs parses the OOXML parts and IGNORES the `vbaProject.bin`
// part entirely — it is a pure-JS reader with no macro engine, so there is no
// execution path for VBA to take. That is a property of the parser, not a flag
// we set, which is why it is safe rather than merely configured safely. (The
// repo already relies on this for the ADR-0039 workbook parser.)
//
// ── Password-protected files ────────────────────────────────────────────────
// Detected from the container's MAGIC BYTES before any parser touches them. An
// encrypted OOXML file is not a damaged .xlsx — it is an OLE/CFB compound file
// with completely different bytes. Sniffing that gives a precise, actionable
// "this needs a password" instead of a generic parse failure, which is what lets
// the caller LATCH the source rather than retrying it forever.

import Papa from 'papaparse';
import type { Prisma } from '@prisma/client';
import { HEADER_SCAN_ROWS, detectHeaderRow } from './header-detect';

/** Why a document could not be read. Each maps to a different operator action. */
export type ParseFailureReason =
  /** Encrypted / password-protected. A human must supply an unprotected copy. */
  | 'password_protected'
  /** Structurally broken — truncated upload, wrong extension, garbage bytes. */
  | 'corrupt'
  /** A format this pipeline has no reader for. Not an error, just not parsable. */
  | 'unsupported';

export interface SheetSummary {
  name: string;
  rowCount: number;
  /** Header labels from the DETECTED header row, normalized. */
  headers: string[];
  /**
   * ADR-0067 Am.8 — which row the headers came from (1-based), and how sure we
   * are. Recorded because the previous behaviour ("first non-empty row") was
   * wrong on 3 of 3 live workbooks and nothing ever showed what it had picked,
   * which is why it survived. A wrong guess must be visible, not silent.
   */
  headerRowIndex: number;
  headerConfidence: 'strong' | 'weak' | 'none';
  /** Title/section rows skipped above the header — kept as classifier signal. */
  titleRows: string[];
  /** Headers with at least one non-empty value below them. */
  populatedColumns: string[];
  /**
   * Sum of the numeric cells under each header. This is the "billing/inventory
   * aggregate" the D7 variance check moves against — expressed per column so a
   * change can name WHICH figure moved rather than reporting one opaque total.
   */
  numericTotals: Record<string, number>;
}

export interface ParseSummary {
  format: 'xlsx' | 'csv' | 'pdf' | 'text';
  sheets: SheetSummary[];
  /** Total data rows across every sheet — the D7 row-drop denominator. */
  totalRows: number;
  /** Bounded text sample for the classifier. Never the whole document. */
  textSample: string;
}

export type ParseResult =
  | { ok: true; summary: ParseSummary }
  | { ok: false; reason: ParseFailureReason; message: string };

/** How much text the classifier is allowed to see. Bounds cost and context. */
const TEXT_SAMPLE_CHARS = 8_000;
/** Rows scanned per sheet when summarizing. A ledger tab can be enormous. */
const MAX_SCAN_ROWS = 20_000;

/**
 * OLE2/CFB compound-file magic (`D0 CF 11 E0 A1 B1 1A E1`).
 *
 * A password-protected .xlsx/.xlsm is an OLE container wrapping an encrypted
 * package, NOT a zip. A plain .xlsx/.xlsm is a zip (`PK\x03\x04`). Sniffing the
 * first eight bytes therefore distinguishes "needs a password" from "damaged"
 * with certainty, before any parser has to guess.
 */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

export function looksPasswordProtected(bytes: Uint8Array, filename: string): boolean {
  if (isSpreadsheetName(filename) && startsWith(bytes, OLE_MAGIC)) return true;
  // An encrypted PDF still parses as a PDF; pdf-parse raises instead. Handled below.
  return false;
}

function isSpreadsheetName(filename: string): boolean {
  return /\.(xlsx|xlsm|xltx|xltm)$/i.test(filename);
}

export interface ParseDeps {
  /** Injectable so tests never load exceljs/pdf-parse. */
  readWorkbook?: (bytes: Uint8Array) => Promise<ParseSummary>;
  readPdfText?: (bytes: Uint8Array) => Promise<string>;
}

/**
 * Parse a document into its structural summary.
 *
 * NEVER throws. Every failure is a typed reason, because the caller's decision
 * (latch vs retry vs page) depends entirely on WHY it failed, and an exception
 * would flatten that back into "something went wrong".
 */
export async function parseDocument(
  bytes: Uint8Array,
  filename: string,
  contentType: string | null,
  deps: ParseDeps = {},
): Promise<ParseResult> {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: 'corrupt', message: 'file is empty' };
  }

  if (looksPasswordProtected(bytes, filename)) {
    return {
      ok: false,
      reason: 'password_protected',
      message:
        'the workbook is encrypted (password-protected). Vision cannot open it and will not keep trying.',
    };
  }

  try {
    if (isSpreadsheetName(filename)) {
      if (!startsWith(bytes, ZIP_MAGIC)) {
        return {
          ok: false,
          reason: 'corrupt',
          message: 'file has a spreadsheet extension but is not a valid Office Open XML package',
        };
      }
      const read = deps.readWorkbook ?? readWorkbookWithExcelJs;
      return { ok: true, summary: await read(bytes) };
    }

    if (/\.csv$/i.test(filename) || contentType === 'text/csv') {
      return { ok: true, summary: summarizeCsv(decodeText(bytes)) };
    }

    if (/\.pdf$/i.test(filename) || contentType === 'application/pdf') {
      const read = deps.readPdfText ?? readPdfText;
      const text = await read(bytes);
      return {
        ok: true,
        summary: {
          format: 'pdf',
          sheets: [],
          totalRows: 0,
          textSample: text.slice(0, TEXT_SAMPLE_CHARS),
        },
      };
    }

    if (/\.(txt|md|json|xml)$/i.test(filename) || contentType?.startsWith('text/')) {
      const text = decodeText(bytes);
      return {
        ok: true,
        summary: {
          format: 'text',
          sheets: [],
          totalRows: 0,
          textSample: text.slice(0, TEXT_SAMPLE_CHARS),
        },
      };
    }

    return {
      ok: false,
      reason: 'unsupported',
      message: `no reader for "${filename}" (${contentType ?? 'unknown type'})`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // pdf-parse and exceljs both surface encryption as a thrown error rather
    // than a distinguishable type, so the message is the only signal available.
    // Getting this wrong in the safe direction costs a retry; getting it wrong
    // the other way means retrying a password prompt forever.
    if (/password|encrypt/i.test(message)) {
      return { ok: false, reason: 'password_protected', message };
    }
    return { ok: false, reason: 'corrupt', message };
  }
}

// ── Readers ────────────────────────────────────────────────────────────────

async function readWorkbookWithExcelJs(bytes: Uint8Array): Promise<ParseSummary> {
  // Dynamic import so exceljs never enters the sweep's module graph until a
  // spreadsheet actually arrives — same reasoning as the AP extraction fallback.
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  // `Buffer` view over the SAME memory — no copy. exceljs reads the OOXML parts
  // and never touches vbaProject.bin, so an .xlsm is parsed without its macros
  // existing as far as this process is concerned.
  //
  // The cast matches the repo's existing workbook readers
  // (workbook-sync/daily-adapter.ts, audit/workbook/parser.ts): exceljs declares
  // its own `Buffer` alias that @types/node's generic `Buffer<ArrayBufferLike>`
  // no longer satisfies structurally. Taken off `load` itself so it tracks the
  // library's own signature instead of naming a type that may be renamed.
  type ExcelBuffer = Parameters<typeof workbook.xlsx.load>[0];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await workbook.xlsx.load(view as unknown as ExcelBuffer);

  const sheets: SheetSummary[] = [];
  const textParts: string[] = [];
  let totalRows = 0;

  workbook.eachSheet((worksheet) => {
    const populated = new Set<string>();
    const totals: Record<string, number> = {};
    let dataRows = 0;

    const limit = Math.min(worksheet.rowCount, MAX_SCAN_ROWS);

    // ── ADR-0067 Am.8 — find the REAL header row ────────────────────────────
    // Read the top of the sheet first, then decide. The previous code committed
    // to the first non-empty row on sight, which is a merged TITLE row on every
    // live workbook — so the recorded "headers" were document titles, and both
    // the structure half of the classifier and the aggregate guardrail were
    // silently comparing nothing.
    //
    // `maxCellCount` is taken across the whole scan window rather than from the
    // title row alone: a title row reports a narrow `cellCount`, and measuring
    // width from it would make the title look full-width and win.
    const probe: string[][] = [];
    let maxCellCount = 0;
    for (let r = 1; r <= Math.min(limit, HEADER_SCAN_ROWS); r += 1) {
      maxCellCount = Math.max(maxCellCount, worksheet.getRow(r).cellCount);
    }
    for (let r = 1; r <= Math.min(limit, HEADER_SCAN_ROWS); r += 1) {
      const row = worksheet.getRow(r);
      const values: string[] = [];
      for (let c = 1; c <= maxCellCount; c += 1) values.push(cellToText(row.getCell(c).value));
      probe.push(values);
    }
    const detected = detectHeaderRow(probe);
    const headers = detected.headers;

    // Data starts BELOW the detected header. A sheet with no usable header
    // (confidence 'none') has no columns to attribute values to, so it
    // contributes no totals rather than attributing them to invented names.
    const firstDataRow = detected.headerRowIndex === 0 ? limit + 1 : detected.headerRowIndex + 1;
    for (let r = firstDataRow; r <= limit; r += 1) {
      const row = worksheet.getRow(r);
      const cellCount = Math.max(row.cellCount, headers.length);
      const values: string[] = [];
      let nonEmpty = 0;
      for (let c = 1; c <= cellCount; c += 1) {
        const text = cellToText(row.getCell(c).value);
        values.push(text);
        if (text) nonEmpty += 1;
      }
      if (nonEmpty === 0) continue;

      dataRows += 1;
      for (let i = 0; i < headers.length; i += 1) {
        const header = headers[i];
        const raw = values[i];
        if (!header || !raw) continue;
        populated.add(header);
        const n = Number.parseFloat(raw.replace(/[$,\s]/g, ''));
        if (Number.isFinite(n)) totals[header] = (totals[header] ?? 0) + n;
      }
    }

    totalRows += dataRows;
    sheets.push({
      name: worksheet.name,
      rowCount: dataRows,
      headers: headers.filter((h) => h.length > 0),
      headerRowIndex: detected.headerRowIndex,
      headerConfidence: detected.confidence,
      titleRows: detected.titleRows,
      populatedColumns: [...populated].sort(),
      numericTotals: totals,
    });
    // Title rows join the text sample: they are useful CLASSIFIER signal (the
    // commodity tracker announces itself in its title) even though they are not
    // column names.
    textParts.push(
      `[sheet: ${worksheet.name}] ${[...detected.titleRows, headers.filter(Boolean).join(' | ')]
        .filter(Boolean)
        .join(' | ')}`,
    );
  });

  return {
    format: 'xlsx',
    sheets,
    totalRows,
    textSample: textParts.join('\n').slice(0, TEXT_SAMPLE_CHARS),
  };
}

function summarizeCsv(text: string): ParseSummary {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const rows = Array.isArray(parsed.data) ? parsed.data : [];

  // ADR-0067 Am.8 — the same detection as the workbook path. An exported CSV
  // carries the same merged-title first line as the sheet it came from, so
  // assuming row 0 here reproduces exactly the defect being fixed above.
  const detected = detectHeaderRow(
    rows.slice(0, 12).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])),
  );
  const headers = detected.headers.filter((h) => h.length > 0);

  const populated = new Set<string>();
  const totals: Record<string, number> = {};
  let dataRows = 0;

  const firstDataRow = detected.headerRowIndex === 0 ? rows.length : detected.headerRowIndex;
  for (let r = firstDataRow; r < Math.min(rows.length, MAX_SCAN_ROWS); r += 1) {
    const row = rows[r];
    if (!row) continue;
    dataRows += 1;
    for (let i = 0; i < headers.length; i += 1) {
      const header = headers[i];
      const raw = String(row[i] ?? '').trim();
      if (!header || !raw) continue;
      populated.add(header);
      const n = Number.parseFloat(raw.replace(/[$,\s]/g, ''));
      if (Number.isFinite(n)) totals[header] = (totals[header] ?? 0) + n;
    }
  }

  return {
    format: 'csv',
    sheets: [
      {
        name: 'csv',
        rowCount: dataRows,
        headers,
        headerRowIndex: detected.headerRowIndex,
        headerConfidence: detected.confidence,
        titleRows: detected.titleRows,
        populatedColumns: [...populated].sort(),
        numericTotals: totals,
      },
    ],
    totalRows: dataRows,
    textSample: text.slice(0, TEXT_SAMPLE_CHARS),
  };
}

/**
 * PDF text, via the SAME extractor the AP pipeline uses.
 *
 * Reused rather than reimplemented: `extractPdfText` already wraps pdf-parse v2's
 * `PDFParse` class API correctly and dynamic-imports it so pdfjs never loads
 * until a PDF actually arrives. A second reader would be a second thing to keep
 * in step with that dependency's API.
 *
 * Known limitation, inherited deliberately: it is FAIL-SOFT and returns '' for an
 * encrypted PDF, a corrupt one, and a scanned image with no text layer alike —
 * so a password-protected PDF surfaces as "no extractable text", not as
 * `password_protected`. The magic-byte sniff above gives that precision for
 * WORKBOOKS, which is where it matters: the daily logs are `.xlsm`, and a PDF
 * with no text is a real and common non-error state that must not latch.
 */
async function readPdfText(bytes: Uint8Array): Promise<string> {
  const { extractPdfText } = await import('@/lib/ap/extraction/local-parser');
  return extractPdfText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Flatten an exceljs cell value to display text.
 *
 * A FORMULA cell is read through its cached `result`, never its expression: the
 * cached value is what Excel last computed and therefore what a human reading
 * the workbook sees. Summing the formula strings instead would silently produce
 * zero for every calculated column — which is most of the interesting ones.
 */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('result' in obj) return cellToText(obj['result']);
    if ('text' in obj) return cellToText(obj['text']);
    if ('richText' in obj && Array.isArray(obj['richText'])) {
      return (obj['richText'] as { text?: unknown }[])
        .map((p) => String(p.text ?? ''))
        .join('')
        .trim();
    }
    if ('hyperlink' in obj) return cellToText(obj['text'] ?? obj['hyperlink']);
    if ('error' in obj) return '';
  }
  return String(value).trim();
}

/** Persisted onto `doc_source_versions.parse_summary`. */
export function summaryToJson(summary: ParseSummary): Prisma.InputJsonValue {
  return summary as unknown as Prisma.InputJsonValue;
}

/**
 * Read a persisted summary back. Returns null for anything that is not a
 * recognizable summary — an older shape, a hand-edited row — so the guardrail
 * treats it as "no baseline" and auto-applies rather than comparing against
 * garbage and staging a change for no reason.
 */
export function summaryFromJson(value: unknown): ParseSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj['sheets']) || typeof obj['totalRows'] !== 'number') return null;
  return {
    format: (obj['format'] as ParseSummary['format']) ?? 'text',
    sheets: obj['sheets'] as SheetSummary[],
    totalRows: obj['totalRows'],
    textSample: typeof obj['textSample'] === 'string' ? obj['textSample'] : '',
  };
}
