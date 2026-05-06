// MyMRC scheduled-hauls table parser.
//
// Responsibility: take raw HTML containing the scheduled-hauls table and
// produce a normalized list of `ScrapedHaul` rows. No Playwright
// dependency, no DB dependency, no env reads — pure transformation so
// the test suite can throw fixtures at it without browser orchestration.
//
// Why we parse HTML instead of using Playwright row APIs: the structure
// of the MyMRC table is unstable across Salesforce themes (Lightning
// vs. Aloha), but the column headers + data semantics are stable. A
// header-driven parse survives DOM reshuffling that a positional
// `locator('tr td:nth-child(3)')` chain would break on.
//
// Parsing rules:
//   - Header row drives column lookup. Match is case-insensitive,
//     whitespace-collapsed, substring-tolerant ("Haul: Haul ID" matches
//     "haul id"). One canonical key per logical column.
//   - Date parsing: MM/DD/YYYY. Anchored at noon UTC so a flip to local
//     time doesn't change the displayed date in the operator UI.
//   - Numeric parsing: strip commas and whitespace, parse as integer.
//   - Empty / blank cells → `null` for optional fields. The haul ID and
//     date are required — a row missing either is dropped silently.
//   - Address field with embedded `<br>` is decoded but NOT split here;
//     the caller already has structured source records to match against.

import type { ScrapedHaul } from './types';

const COLUMN_KEYS = {
  haulId: ['haul: haul id', 'haul id'],
  deliveryDate: ['recycler reported delivery date', 'delivery date'],
  source: ['collection site'],
  transporter: ['transporter'],
  unitCount: ['recycler program unit count', 'unit count at unload'],
  bol: ['reference number', 'bol number', 'bol'],
  scheduledAt: ['scheduled at', 'scheduled at mymrc'],
} as const;

type ColumnKey = keyof typeof COLUMN_KEYS;

/**
 * Parse the HTML of a MyMRC scheduled-hauls table into ScrapedHaul rows.
 *
 * Accepts either the full page HTML (the parser will locate the first
 * `<table>` containing a "haul" header) or just the `<table>...</table>`
 * fragment. Returns an empty array when the table is missing or empty —
 * the caller decides whether that's a failure (auth issue) or a normal
 * "no upcoming hauls" state (good to upsert nothing + clear stale rows).
 */
export function parseScheduledHaulsHtml(html: string): ScrapedHaul[] {
  const tableHtml = extractTable(html);
  if (!tableHtml) return [];

  const rows = extractRows(tableHtml);
  if (rows.length === 0) return [];

  const headerCells = extractCells(rows[0] ?? '');
  const colIndex = mapHeaderColumns(headerCells);

  // A valid hauls table must at minimum carry the haul-id and
  // delivery-date columns; anything else is an indicator we're looking
  // at the wrong table (e.g. an empty-state placeholder rendered as a
  // table by the Salesforce shell).
  if (colIndex.haulId === undefined || colIndex.deliveryDate === undefined) {
    return [];
  }

  const out: ScrapedHaul[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = extractCells(rows[i] ?? '');
    if (cells.length === 0) continue;
    const haul = rowToHaul(cells, colIndex);
    if (haul) out.push(haul);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────

function extractTable(html: string): string | null {
  // Prefer the canonical data-purpose attribute; fall back to first
  // table containing a "haul" header. Both regexes operate on the
  // already-normalized markup so they are tolerant of whitespace.
  const dataPurpose = html.match(
    /<table[^>]*data-purpose=["']scheduled-hauls["'][^>]*>([\s\S]*?)<\/table>/i,
  );
  if (dataPurpose) return dataPurpose[0];

  const tables = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi);
  if (!tables) return null;
  for (const t of tables) {
    if (/haul\s*id/i.test(t)) return t;
  }
  return null;
}

function extractRows(tableHtml: string): string[] {
  const matches = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi);
  return matches ?? [];
}

function extractCells(rowHtml: string): string[] {
  const cellMatches = rowHtml.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi);
  if (!cellMatches) return [];
  return cellMatches.map(stripCellHtml);
}

function stripCellHtml(cellHtml: string): string {
  // Strip the outer <td>/<th> tags + any inline element content
  // (anchors, spans, formatting). Replace `<br>` with `\n` so multi-line
  // address values survive readably; downstream callers split on `\n`.
  const inner = cellHtml.replace(/^<t[hd]\b[^>]*>/i, '').replace(/<\/t[hd]>\s*$/i, '');
  const noBr = inner.replace(/<br\s*\/?>(?!\s*$)/gi, '\n');
  const noTags = noBr.replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(noTags).trim();
}

function decodeHtmlEntities(s: string): string {
  // Minimal whitelist — covers what MyMRC actually emits in the haul
  // table. We deliberately avoid pulling in `he` or another entity
  // library to keep the bundle slim and the attack surface tiny.
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function normaliseHeader(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function mapHeaderColumns(headerCells: string[]): Partial<Record<ColumnKey, number>> {
  const out: Partial<Record<ColumnKey, number>> = {};
  for (let i = 0; i < headerCells.length; i++) {
    const norm = normaliseHeader(headerCells[i] ?? '');
    for (const key of Object.keys(COLUMN_KEYS) as ColumnKey[]) {
      if (out[key] !== undefined) continue;
      for (const candidate of COLUMN_KEYS[key]) {
        if (norm.includes(candidate)) {
          out[key] = i;
          break;
        }
      }
    }
  }
  return out;
}

function rowToHaul(
  cells: string[],
  colIndex: Partial<Record<ColumnKey, number>>,
): ScrapedHaul | null {
  const haulIdRaw = pickCell(cells, colIndex.haulId);
  const dateRaw = pickCell(cells, colIndex.deliveryDate);
  if (!haulIdRaw || !dateRaw) return null;

  const expectedArrival = parseDeliveryDate(dateRaw);
  if (!expectedArrival) return null;

  const sourceName = pickCell(cells, colIndex.source) ?? '';
  if (!sourceName) return null;

  return {
    external_mymrc_haul_id: haulIdRaw,
    expected_arrival_at: expectedArrival,
    source_name: sourceName,
    transporter_name: pickCell(cells, colIndex.transporter),
    expected_unit_count: parseIntOrNull(pickCell(cells, colIndex.unitCount)),
    bol_number: pickCell(cells, colIndex.bol),
    scheduled_at_mymrc: parseScheduledAt(pickCell(cells, colIndex.scheduledAt)),
  };
}

function pickCell(cells: string[], idx: number | undefined): string | null {
  if (idx === undefined) return null;
  const v = cells[idx];
  if (v === undefined) return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function parseDeliveryDate(raw: string): Date | null {
  // MM/DD/YYYY — Salesforce's default in en-US locale, which is what
  // MRC's tenant uses. We anchor the resulting Date at 12:00 UTC so
  // that `expected_arrival_at` for a "2026-05-08" haul renders as
  // 2026-05-08 in every US timezone the operator app might be served
  // from. The dock workflow only uses this field for ordering and
  // display — there is no millisecond-level semantics.
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const month = Number.parseInt(m[1] ?? '', 10);
  const day = Number.parseInt(m[2] ?? '', 10);
  let year = Number.parseInt(m[3] ?? '', 10);
  if (Number.isNaN(month) || Number.isNaN(day) || Number.isNaN(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 100) year += 2000;
  // Date.UTC validates the calendar — Feb 30 rolls into March, which we
  // explicitly want to reject as bad parse rather than silently accept.
  const ts = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const d = new Date(ts);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function parseScheduledAt(raw: string | null): Date | null {
  if (!raw) return null;
  // Salesforce often emits ISO timestamps for the "scheduled at" column
  // when present; accept either ISO or MM/DD/YYYY HH:mm.
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return new Date(iso);
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let year = Number.parseInt(m[3] ?? '', 10);
  if (year < 100) year += 2000;
  const month = Number.parseInt(m[1] ?? '', 10);
  const day = Number.parseInt(m[2] ?? '', 10);
  const hour = Number.parseInt(m[4] ?? '', 10);
  const minute = Number.parseInt(m[5] ?? '', 10);
  if ([month, day, hour, minute].some((n) => Number.isNaN(n))) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

function parseIntOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/[\s,]/g, '');
  if (cleaned === '') return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}
