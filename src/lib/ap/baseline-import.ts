// ADR-0046 Amendment 5 (D-M5-4) — Bill-uploaded AP-report import.
//
// Bill drops a GP AP-history PDF into /admin/file-drop; an admin picks it on
// /admin/ap/baselines/import. This module turns that PDF into normalized rows
// `{ vendorName, invoiceDate, invoiceAmountCents, siteCode }` for a PREVIEW (no
// write), then — on the admin's explicit confirm — appends them to
// `ap_vendor_baseline_history` (source='bill_upload') and rebuilds the aggregated
// baselines. Extraction is hybrid: a deterministic local line parser first
// (`parseBaselineText`, pure + unit-tested); a Claude-API structuring fallback
// (`structureRowsWithClaude`, injectable seam mirroring extraction/claude-fallback)
// is available when the local parser finds too few rows to trust. The parser NEVER
// invents a row — a line without both a date and an amount is returned as
// `unparsed` for the admin to see, never silently dropped.

import type Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { extractPdfText, parseUsdToCents } from './extraction/local-parser';
import { apExtractionClaudeModel, apExtractionClaudeTimeoutMs } from './extraction/config';
import { rebuildVendorBaselines } from './baselines';
import { normalizeVendorName } from './variance';

/// One normalized invoice row, ready to preview + (on confirm) persist.
export interface ImportedInvoiceRow {
  vendorName: string;
  /// YYYY-MM-DD calendar day.
  invoiceDate: string;
  invoiceAmountCents: number;
  /// 'woodland' | 'eugene' | null (a combined report may not resolve a site).
  siteCode: string | null;
}

export interface ParsedBaseline {
  rows: ImportedInvoiceRow[];
  /// Lines that looked like data (had text) but lacked a date+amount pair — surfaced
  /// so the admin sees what was skipped rather than trusting a silent drop.
  unparsedLines: string[];
  /// 'local' when the local parser sufficed; 'claude_api' when the fallback ran.
  source: 'local' | 'claude_api';
}

// A date at the start-or-anywhere of a line: ISO (2026-03-15) or US M/D/Y.
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b|\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
// USD amount (labeled or bare); we take the LAST on a line as the invoice total.
const AMOUNT_RE = /\$?\d[\d,]*\.\d{2}(?!\d)/g;
const SITE_RE = /\b(woodland|eugene)\b/i;

/** Parse an ISO or US M/D/Y token into a YYYY-MM-DD string, or null. */
export function parseImportDate(token: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (iso) {
    const [, y, m, d] = iso;
    const mm = Number(m);
    const dd = Number(d);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${y}-${m}-${d}`;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(token);
  if (us) {
    const mm = Number(us[1]);
    const dd = Number(us[2]);
    let yy = Number(us[3]);
    if (yy < 100) yy += 2000;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return null;
}

/**
 * PURE local tabular parse: one candidate invoice per text line that carries BOTH a
 * date and a dollar amount. Vendor = the line with the date, all amounts, and any
 * site token stripped (collapsed whitespace); the LAST amount on the line is the
 * invoice total (AP report rows put the total rightmost). A content-bearing line
 * missing a date or amount is returned in `unparsedLines`. Never invents a row.
 */
export function parseBaselineText(text: string): { rows: ImportedInvoiceRow[]; unparsedLines: string[] } {
  const rows: ImportedInvoiceRow[] = [];
  const unparsedLines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;

    const dateMatch = DATE_RE.exec(line);
    const dateToken = dateMatch ? (dateMatch[1] ?? dateMatch[2] ?? '') : '';
    const isoDate = dateToken ? parseImportDate(dateToken) : null;

    const amounts = [...line.matchAll(AMOUNT_RE)].map((m) => m[0]);
    const lastAmount = amounts.length ? amounts[amounts.length - 1]! : null;
    const cents = lastAmount ? parseUsdToCents(lastAmount) : null;

    if (!isoDate || cents === null) {
      // Only warn on lines that carry alphabetic text (skip rule/separator lines).
      if (/[A-Za-z]/.test(line)) unparsedLines.push(line.slice(0, 200));
      continue;
    }

    const siteMatch = SITE_RE.exec(line);
    const siteCode = siteMatch ? siteMatch[1]!.toLowerCase() : null;

    let vendor = line;
    if (dateToken) vendor = vendor.replace(dateToken, ' ');
    for (const a of amounts) vendor = vendor.replace(a, ' ');
    if (siteMatch) vendor = vendor.replace(siteMatch[0], ' ');
    // Strip common ledger noise (leading/trailing separators, invoice-no columns).
    vendor = vendor.replace(/[|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    if (vendor === '') {
      unparsedLines.push(line.slice(0, 200));
      continue;
    }
    rows.push({ vendorName: vendor, invoiceDate: isoDate, invoiceAmountCents: cents, siteCode });
  }
  return { rows, unparsedLines };
}

/// The injectable model-call seam (identical contract to extraction/claude-fallback).
export interface StructuringModelCall {
  (args: {
    model: string;
    timeoutMs: number;
    system: string;
    content: Anthropic.ContentBlockParam[];
  }): Promise<{ text: string }>;
}

const STRUCT_SYSTEM =
  'You are an accounts-payable report parser. From the AP report text, extract every ' +
  'invoice row. Respond with ONLY a JSON array and no other prose.';
const STRUCT_USER =
  'Extract every invoice as JSON array of objects: { vendor_name (string), ' +
  'invoice_date (YYYY-MM-DD), invoice_amount_cents (integer US cents), ' +
  'site (one of "woodland","eugene", or null) }.\n\nAP report text:\n';

const defaultStructuringCall: StructuringModelCall = async ({ model, timeoutMs, system, content }) => {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const client = new AnthropicClient({
    apiKey: process.env['ANTHROPIC_API_KEY'],
    timeout: timeoutMs,
    maxRetries: 0,
  });
  const resp = await client.messages.create({
    model,
    max_tokens: 8192,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text };
};

/** Coerce one raw JSON object into an ImportedInvoiceRow, or null if invalid. */
function coerceRow(o: Record<string, unknown>): ImportedInvoiceRow | null {
  const vendorRaw = typeof o['vendor_name'] === 'string' ? o['vendor_name'].trim() : '';
  const dateRaw = typeof o['invoice_date'] === 'string' ? o['invoice_date'] : '';
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? parseImportDate(dateRaw) : null;
  const amt = o['invoice_amount_cents'];
  const cents = typeof amt === 'number' && Number.isFinite(amt) ? Math.round(amt) : null;
  const siteRaw = typeof o['site'] === 'string' ? o['site'].toLowerCase() : null;
  const siteCode = siteRaw === 'woodland' || siteRaw === 'eugene' ? siteRaw : null;
  if (!vendorRaw || !isoDate || cents === null) return null;
  return { vendorName: vendorRaw, invoiceDate: isoDate, invoiceAmountCents: cents, siteCode };
}

/// Parse a Claude JSON-array response into rows. Tolerates leading/trailing prose.
export function parseStructuredRows(text: string): ImportedInvoiceRow[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ImportedInvoiceRow[] = [];
  for (const item of parsed) {
    if (item && typeof item === 'object') {
      const row = coerceRow(item as Record<string, unknown>);
      if (row) out.push(row);
    }
  }
  return out;
}

/// Claude structuring fallback. Never throws — returns [] on any failure.
export async function structureRowsWithClaude(
  text: string,
  modelCall: StructuringModelCall = defaultStructuringCall,
): Promise<ImportedInvoiceRow[]> {
  try {
    const { text: out } = await modelCall({
      model: apExtractionClaudeModel(),
      timeoutMs: apExtractionClaudeTimeoutMs(),
      system: STRUCT_SYSTEM,
      content: [{ type: 'text', text: STRUCT_USER + text.slice(0, 60_000) }],
    });
    return parseStructuredRows(out);
  } catch {
    return [];
  }
}

/// Below this local row count we try the Claude structuring fallback (a real AP
/// report has many rows; a near-empty local parse means the layout defeated the
/// line heuristic).
export const LOCAL_ROW_TRUST_FLOOR = 3;

export interface ParseBaselineOptions {
  /// Test/DI seam; defaults to the real SDK call. Fallback only runs when the key is
  /// configured (`fallbackEnabled`) AND the local parse is below the trust floor.
  modelCall?: StructuringModelCall;
  fallbackEnabled?: boolean;
}

/**
 * Parse an uploaded AP-report PDF's bytes into preview rows. Local line parse
 * first; if it yields fewer than {@link LOCAL_ROW_TRUST_FLOOR} rows AND the Claude
 * fallback is enabled, re-parse the extracted text with Claude and prefer whichever
 * yielded more rows. Fully fail-soft — a PDF with no text layer returns zero rows +
 * the raw lines it could see.
 */
export async function parseBaselinePdf(
  bytes: Buffer,
  opts: ParseBaselineOptions = {},
): Promise<ParsedBaseline> {
  const text = await extractPdfText(bytes);
  const local = parseBaselineText(text);
  if (local.rows.length >= LOCAL_ROW_TRUST_FLOOR || !opts.fallbackEnabled) {
    return { rows: local.rows, unparsedLines: local.unparsedLines, source: 'local' };
  }
  const claudeRows = await structureRowsWithClaude(text, opts.modelCall);
  if (claudeRows.length > local.rows.length) {
    return { rows: claudeRows, unparsedLines: local.unparsedLines, source: 'claude_api' };
  }
  return { rows: local.rows, unparsedLines: local.unparsedLines, source: 'local' };
}

export interface ConfirmBaselineArgs {
  prisma: PrismaClient;
  rows: readonly ImportedInvoiceRow[];
  importedByUserId: string;
  /// Resolves a site CODE ('woodland'|'eugene') to a sites.id; unknown → null.
  siteIdByCode: (code: string) => string | null;
}

export interface ConfirmBaselineResult {
  historyRowsWritten: number;
  vendorsComputed: number;
}

/**
 * Persist the admin-approved preview rows as `bill_upload` history, then rebuild the
 * aggregated baselines. The history insert + the rebuild's own transaction commit
 * the freshly-imported data and immediately recompute every vendor's baseline
 * (preserving admin overrides). Idempotency is NOT enforced at the DB level here —
 * re-importing the same report duplicates history rows — so the admin confirms a
 * report once; the preview step is the guard.
 */
export async function confirmBaselineImport(args: ConfirmBaselineArgs): Promise<ConfirmBaselineResult> {
  const { prisma, rows, importedByUserId, siteIdByCode } = args;
  const clean = rows.filter((r) => normalizeVendorName(r.vendorName) && Number.isFinite(r.invoiceAmountCents));

  await prisma.$transaction(
    clean.map((r) =>
      prisma.apVendorBaselineHistory.create({
        data: {
          vendor_name: r.vendorName.trim(),
          vendor_name_normalized: normalizeVendorName(r.vendorName),
          invoice_date: new Date(`${r.invoiceDate}T00:00:00.000Z`),
          invoice_amount_cents: Math.round(r.invoiceAmountCents),
          site_id: r.siteCode ? siteIdByCode(r.siteCode) : null,
          source: 'bill_upload',
          imported_by: importedByUserId,
        },
      }),
    ),
  );

  const rebuild = await rebuildVendorBaselines(prisma);
  return { historyRowsWritten: clean.length, vendorsComputed: rebuild.vendorsComputed };
}
