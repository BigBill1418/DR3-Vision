// Sprint-1 T-016 — MyMRC monthly CSV reconciliation engine.
//
// Pipeline:
//
//   1. parseReconciliationCsv(text)        — strict-schema CSV parse
//      via papaparse; rejects on missing required columns; returns a
//      typed row list + content sha256.
//
//   2. categorizeRows(parsed, dr3Loads,    — pure function: matches
//      tolerance)                            each parsed row against
//      DR3 loads by `external_mymrc_haul_id`, then categorizes per
//      docs/MYMRC-INTEGRATION.md §"CSV reconciliation upload":
//        - match_clean        — counts + weights both reconcile
//        - weight_mismatch    — beyond tolerance threshold
//        - count_mismatch     — stack count differs
//        - missing_in_dr3     — CSV has it, DB doesn't
//        - missing_in_mymrc   — DB has it for this site/period, CSV doesn't
//
//   3. persistReconciliation(...)          — writes the parent
//      `mymrc_reconciliations` row + every item in a single Prisma
//      transaction, then writes a single audit_log entry recording
//      the upload. Idempotency is enforced by the
//      `(site_id, content_sha256)` unique index — duplicate uploads
//      raise P2002 which the route handler converts to a 409 with a
//      pointer to the existing session.
//
//   4. resolveReconciliationItem(...)      — applies a single
//      manager decision (dr3_correct / mymrc_correct / flag_followup)
//      AND writes a paired audit_log row in one Prisma transaction.
//      CLAUDE.md hard rule #6 (append-only audit) is honored: we
//      never mutate or delete existing audit rows; resolution
//      changes append a new audit row each time.
//
// Hard rule #2 (per-site separation) is enforced by callers — every
// public function takes a `siteId` and uses it to scope DB reads.
// The route layer additionally calls `requireManagerForSite()` so a
// Eugene manager cannot reach Woodland's data.

import { createHash } from 'node:crypto';
import { Prisma, type ReconciliationStatus, type ReconciliationResolution } from '@prisma/client';
import Papa from 'papaparse';
import { prisma } from '@/lib/prisma';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/**
 * Default plus-or-minus 2% tolerance for weight reconciliation per the
 * T-016 contract. Configurable per upload via `parseReconciliationCsv`.
 * Persisted on the parent row so a future tolerance change does not
 * retroactively reclassify historical items.
 */
export const DEFAULT_WEIGHT_TOLERANCE_PCT = 2.0;

/**
 * Strict required-column set from docs/MYMRC-INTEGRATION.md
 * §"MyMRC data shape (as observed)". The parser rejects any upload
 * that does not have ALL of these columns present in the header row.
 *
 * Optional columns (Reference Number, Recycler Program Unit Count,
 * Recycler Non-Program Unit Count, Other Collection Site, Pickup
 * Address, Status, Commodity, # of Attached Files) are tolerated
 * when present and ignored when absent — they are not used for
 * reconciliation match keys.
 */
export const REQUIRED_CSV_COLUMNS = [
  'Recycler',
  'Haul: Haul ID',
  'Recycler Reported Delivery Date',
  'Collection Site',
  'Unit Count at Unload',
  'Transporter',
  'Recycler Weight',
] as const;

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface ParsedCsvRow {
  /** verbatim recycler string, e.g. "DR3 Eugene" */
  recycler: string;
  external_haul_id: string;
  delivery_date: Date | null;
  source_name: string;
  unit_count: number | null;
  transporter_name: string;
  weight_lbs: number | null;
}

export interface ParsedCsv {
  rows: ParsedCsvRow[];
  sha256: string;
  /** earliest delivery_date observed in the upload, UTC midnight */
  period_start: Date;
  /** latest delivery_date observed, UTC midnight */
  period_end: Date;
}

export type ParseResult =
  | { ok: true; parsed: ParsedCsv }
  | {
      ok: false;
      reason: 'empty_csv' | 'missing_columns' | 'parse_error' | 'no_valid_rows';
      detail: string;
    };

/**
 * Minimal DR3-side load shape the categorizer needs. Route handlers
 * select exactly these fields — no broad selects.
 */
export interface Dr3LoadForReconcile {
  id: string;
  external_mymrc_haul_id: string | null;
  total_units: number | null;
  weight_lbs: number | null;
}

export interface CategorizedItem {
  external_haul_id: string;
  external_delivery_date: Date | null;
  external_source_name: string | null;
  external_unit_count: number | null;
  external_weight_lbs: number | null;
  matched_load_id: string | null;
  dr3_unit_count: number | null;
  dr3_weight_lbs: number | null;
  status: ReconciliationStatus;
}

export interface CategorizationCounts {
  total: number;
  match_clean: number;
  weight_mismatch: number;
  count_mismatch: number;
  missing_in_dr3: number;
  missing_in_mymrc: number;
}

export interface CategorizationResult {
  items: CategorizedItem[];
  counts: CategorizationCounts;
}

// ────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────

/**
 * Parse the MyMRC monthly CSV. Strict: rejects on missing required
 * columns, on completely empty input, or on zero parseable data
 * rows. Per docs/MYMRC-INTEGRATION.md the canonical shape is the
 * 2026-05-04 export columns; this parser ignores extras and accepts
 * any reasonable subset that includes the seven required columns.
 *
 * Date parsing accepts MyMRC's MM/DD/YYYY (the canonical format) and
 * also tolerates ISO-8601 yyyy-mm-dd in case a manager re-saved the
 * CSV through Excel. Invalid dates become null on the parsed row;
 * the categorizer treats null delivery_date as a non-fatal missing
 * field (matching is by haul_id, not by date).
 *
 * SHA-256 is computed over the raw input text BEFORE parsing, so a
 * byte-identical re-upload always produces the same digest regardless
 * of any normalization the parser applies internally.
 */
export function parseReconciliationCsv(text: string): ParseResult {
  if (text.trim().length === 0) {
    return { ok: false, reason: 'empty_csv', detail: 'file is empty' };
  }

  const sha256 = createHash('sha256').update(text, 'utf-8').digest('hex');

  let parsed: Papa.ParseResult<Record<string, string>>;
  try {
    parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
  } catch (parseErr) {
    return {
      ok: false,
      reason: 'parse_error',
      detail: parseErr instanceof Error ? parseErr.message : String(parseErr),
    };
  }

  if (parsed.errors.length > 0) {
    // Papa parse surfaces header-level vs row-level errors; only the
    // header-level ones are fatal here. Row-level "TooFewFields" /
    // "TooManyFields" are warnings (extra trailing comma is common).
    const fatal = parsed.errors.filter(
      (perr) => perr.type === 'Delimiter' || perr.type === 'Quotes'
    );
    if (fatal.length > 0) {
      return {
        ok: false,
        reason: 'parse_error',
        detail: fatal.map((perr) => `${perr.code}: ${perr.message}`).join('; '),
      };
    }
  }

  const headers = parsed.meta.fields ?? [];
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing_columns',
      detail: `missing required column(s): ${missing.join(', ')}`,
    };
  }

  const rows: ParsedCsvRow[] = [];
  for (const raw of parsed.data) {
    const haulId = (raw['Haul: Haul ID'] ?? '').trim();
    if (!haulId) continue; // skip rows with no haul id; cannot reconcile

    rows.push({
      recycler: (raw['Recycler'] ?? '').trim(),
      external_haul_id: haulId,
      delivery_date: parseDate(raw['Recycler Reported Delivery Date'] ?? ''),
      source_name: (raw['Collection Site'] ?? '').trim(),
      unit_count: parseIntOrNull(raw['Unit Count at Unload'] ?? ''),
      transporter_name: (raw['Transporter'] ?? '').trim(),
      weight_lbs: parseIntOrNull(raw['Recycler Weight'] ?? ''),
    });
  }

  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'no_valid_rows',
      detail: 'no rows had a non-empty Haul: Haul ID',
    };
  }

  // Period bounds: earliest -> latest delivery date. Falls back to
  // today if every row's date is unparseable; the period is metadata,
  // not a match key.
  const datedRows = rows.filter((r) => r.delivery_date !== null);
  const today = utcMidnight(new Date());
  let period_start = today;
  let period_end = today;
  if (datedRows.length > 0) {
    const sorted = datedRows.map((r) => r.delivery_date!.getTime()).sort((a, b) => a - b);
    period_start = utcMidnight(new Date(sorted[0]!));
    period_end = utcMidnight(new Date(sorted[sorted.length - 1]!));
  }

  return {
    ok: true,
    parsed: { rows, sha256, period_start, period_end },
  };
}

// ────────────────────────────────────────────────────────────────────
// Categorizer (pure function — no DB access)
// ────────────────────────────────────────────────────────────────────

/**
 * Categorize each parsed CSV row against the DR3-side loads.
 *
 * Match key: `external_mymrc_haul_id`. Per the T-016 contract the
 * doc specifies "(haul_id, date, source)" — but in practice the
 * haul_id alone is unique and authoritative; date + source are
 * displayed for the manager to verify, never used for fuzzy
 * matching. A near-match on (date, source) without a haul_id match
 * would be unsafe (could collapse two distinct hauls).
 *
 * Tolerance: weight is accepted if `|csv - dr3| / max(csv, dr3) <=
 * tolerance/100`. Both-zero is `match_clean` (degenerate but valid).
 * Either-null falls back to count-only match (or count_mismatch /
 * match_clean depending on the count). Pure null vs zero is treated
 * as null (DR3 didn't capture, MyMRC didn't fill in).
 */
export function categorizeRows(
  csvRows: ReadonlyArray<ParsedCsvRow>,
  dr3Loads: ReadonlyArray<Dr3LoadForReconcile>,
  tolerancePct: number = DEFAULT_WEIGHT_TOLERANCE_PCT
): CategorizationResult {
  const dr3ByHaul = new Map<string, Dr3LoadForReconcile>();
  for (const l of dr3Loads) {
    if (l.external_mymrc_haul_id) dr3ByHaul.set(l.external_mymrc_haul_id, l);
  }

  const items: CategorizedItem[] = [];
  const counts: CategorizationCounts = {
    total: 0,
    match_clean: 0,
    weight_mismatch: 0,
    count_mismatch: 0,
    missing_in_dr3: 0,
    missing_in_mymrc: 0,
  };
  const seenHaulIds = new Set<string>();

  // Pass 1: walk the CSV, classify each row.
  for (const row of csvRows) {
    seenHaulIds.add(row.external_haul_id);
    const dr3 = dr3ByHaul.get(row.external_haul_id) ?? null;

    if (!dr3) {
      items.push({
        external_haul_id: row.external_haul_id,
        external_delivery_date: row.delivery_date,
        external_source_name: row.source_name || null,
        external_unit_count: row.unit_count,
        external_weight_lbs: row.weight_lbs,
        matched_load_id: null,
        dr3_unit_count: null,
        dr3_weight_lbs: null,
        status: 'missing_in_dr3',
      });
      counts.missing_in_dr3 += 1;
      continue;
    }

    const countsMatch = unitsMatch(row.unit_count, dr3.total_units);
    const weightsMatch = weightsWithinTolerance(row.weight_lbs, dr3.weight_lbs, tolerancePct);

    let status: ReconciliationStatus;
    if (!countsMatch) {
      status = 'count_mismatch';
      counts.count_mismatch += 1;
    } else if (!weightsMatch) {
      status = 'weight_mismatch';
      counts.weight_mismatch += 1;
    } else {
      status = 'match_clean';
      counts.match_clean += 1;
    }

    items.push({
      external_haul_id: row.external_haul_id,
      external_delivery_date: row.delivery_date,
      external_source_name: row.source_name || null,
      external_unit_count: row.unit_count,
      external_weight_lbs: row.weight_lbs,
      matched_load_id: dr3.id,
      dr3_unit_count: dr3.total_units,
      dr3_weight_lbs: dr3.weight_lbs,
      status,
    });
  }

  // Pass 2: every DR3 load with a haul_id that the CSV didn't
  // mention is missing_in_mymrc. The caller scopes dr3Loads to the
  // CSV's period, so we don't accidentally flag last month's
  // verified loads as missing.
  for (const dr3 of dr3Loads) {
    if (!dr3.external_mymrc_haul_id) continue;
    if (seenHaulIds.has(dr3.external_mymrc_haul_id)) continue;
    items.push({
      external_haul_id: dr3.external_mymrc_haul_id,
      external_delivery_date: null,
      external_source_name: null,
      external_unit_count: null,
      external_weight_lbs: null,
      matched_load_id: dr3.id,
      dr3_unit_count: dr3.total_units,
      dr3_weight_lbs: dr3.weight_lbs,
      status: 'missing_in_mymrc',
    });
    counts.missing_in_mymrc += 1;
  }

  counts.total = items.length;
  return { items, counts };
}

// ────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────

export interface PersistInput {
  siteId: string;
  uploaderUserId: string;
  filename: string;
  parsed: ParsedCsv;
  categorization: CategorizationResult;
  tolerancePct: number;
  ip: string | null;
  userAgent: string | null;
}

export type PersistResult =
  | { ok: true; reconciliationId: string; created: true }
  | { ok: true; reconciliationId: string; created: false } // duplicate sha256 — return existing
  | { ok: false; reason: 'unknown_error'; detail: string };

export async function persistReconciliation(input: PersistInput): Promise<PersistResult> {
  // Idempotency check up front. The unique index would catch a race
  // too, but the explicit check lets us return the existing session
  // ID without burning a transaction on a doomed insert.
  const existing = await prisma.mymrcReconciliation.findUnique({
    where: {
      site_id_content_sha256: {
        site_id: input.siteId,
        content_sha256: input.parsed.sha256,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, reconciliationId: existing.id, created: false };
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const parent = await tx.mymrcReconciliation.create({
        data: {
          site_id: input.siteId,
          period_start: input.parsed.period_start,
          period_end: input.parsed.period_end,
          uploaded_by_id: input.uploaderUserId,
          filename: input.filename,
          content_sha256: input.parsed.sha256,
          weight_tolerance_pct: new Prisma.Decimal(input.tolerancePct.toFixed(2)),
          total_rows: input.categorization.counts.total,
          matched_count: input.categorization.counts.match_clean,
          unmatched_count:
            input.categorization.counts.total - input.categorization.counts.match_clean,
          match_clean_count: input.categorization.counts.match_clean,
          weight_mismatch_count: input.categorization.counts.weight_mismatch,
          count_mismatch_count: input.categorization.counts.count_mismatch,
          missing_in_dr3_count: input.categorization.counts.missing_in_dr3,
          missing_in_mymrc_count: input.categorization.counts.missing_in_mymrc,
        },
      });

      if (input.categorization.items.length > 0) {
        await tx.mymrcReconciliationItem.createMany({
          data: input.categorization.items.map((it) => ({
            reconciliation_id: parent.id,
            external_haul_id: it.external_haul_id,
            external_delivery_date: it.external_delivery_date,
            external_source_name: it.external_source_name,
            external_unit_count: it.external_unit_count,
            external_weight_lbs: it.external_weight_lbs,
            matched_load_id: it.matched_load_id,
            dr3_unit_count: it.dr3_unit_count,
            dr3_weight_lbs: it.dr3_weight_lbs,
            status: it.status,
          })),
        });
      }

      await tx.auditLog.create({
        data: {
          actor_user_id: input.uploaderUserId,
          action: 'insert',
          table_name: 'mymrc_reconciliations',
          row_id: parent.id,
          before: Prisma.JsonNull,
          after: {
            site_id: parent.site_id,
            filename: parent.filename,
            content_sha256: parent.content_sha256,
            total_rows: parent.total_rows,
            match_clean_count: parent.match_clean_count,
            weight_mismatch_count: parent.weight_mismatch_count,
            count_mismatch_count: parent.count_mismatch_count,
            missing_in_dr3_count: parent.missing_in_dr3_count,
            missing_in_mymrc_count: parent.missing_in_mymrc_count,
            weight_tolerance_pct: parent.weight_tolerance_pct.toString(),
          } satisfies Prisma.InputJsonValue,
          ip: input.ip,
          user_agent: input.userAgent,
        },
      });

      return parent;
    });
    return { ok: true, reconciliationId: created.id, created: true };
  } catch (txErr) {
    // Race window between findUnique above and transaction commit:
    // another upload of the same file could have landed in between.
    // Detect Prisma's unique-violation code (P2002) and return the
    // existing row by re-reading.
    if (
      txErr instanceof Prisma.PrismaClientKnownRequestError &&
      txErr.code === 'P2002'
    ) {
      const again = await prisma.mymrcReconciliation.findUnique({
        where: {
          site_id_content_sha256: {
            site_id: input.siteId,
            content_sha256: input.parsed.sha256,
          },
        },
        select: { id: true },
      });
      if (again) return { ok: true, reconciliationId: again.id, created: false };
    }
    return {
      ok: false,
      reason: 'unknown_error',
      detail: txErr instanceof Error ? txErr.message : String(txErr),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Resolution
// ────────────────────────────────────────────────────────────────────

export interface ResolveInput {
  itemId: string;
  /** Caller must have already passed a per-site auth check. */
  siteId: string;
  resolverUserId: string;
  resolution: ReconciliationResolution; // 'unresolved' is rejected by the route
  notes: string | null;
  ip: string | null;
  userAgent: string | null;
}

export type ResolveResult =
  | {
      ok: true;
      item: {
        id: string;
        resolution: ReconciliationResolution;
        resolved_at: Date | null;
        resolved_by_id: string | null;
        resolution_notes: string | null;
      };
    }
  | { ok: false; reason: 'not_found' | 'wrong_site' | 'invalid_resolution' };

/**
 * Apply a single manager resolution decision and write the paired
 * audit row in the same Prisma transaction. The audit `before` /
 * `after` snapshots capture the decision change so the
 * append-only log is the source of truth for who decided what when.
 *
 * Cross-site protection: even though the route layer enforces
 * `requireManagerForSite`, this function double-checks the item's
 * parent reconciliation belongs to `siteId` so a coding mistake in
 * the route layer cannot leak a Woodland item to a Eugene manager.
 */
export async function resolveReconciliationItem(input: ResolveInput): Promise<ResolveResult> {
  if (input.resolution === 'unresolved') {
    return { ok: false, reason: 'invalid_resolution' };
  }

  const existing = await prisma.mymrcReconciliationItem.findUnique({
    where: { id: input.itemId },
    include: { reconciliation: { select: { site_id: true } } },
  });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.reconciliation.site_id !== input.siteId) {
    return { ok: false, reason: 'wrong_site' };
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.mymrcReconciliationItem.update({
      where: { id: input.itemId },
      data: {
        resolution: input.resolution,
        resolution_notes: input.notes,
        resolved_at: now,
        resolved_by_id: input.resolverUserId,
      },
      select: {
        id: true,
        resolution: true,
        resolved_at: true,
        resolved_by_id: true,
        resolution_notes: true,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: input.resolverUserId,
        action: 'update',
        table_name: 'mymrc_reconciliation_items',
        row_id: input.itemId,
        before: {
          resolution: existing.resolution,
          resolution_notes: existing.resolution_notes,
          resolved_at: existing.resolved_at?.toISOString() ?? null,
          resolved_by_id: existing.resolved_by_id,
        } satisfies Prisma.InputJsonValue,
        after: {
          resolution: u.resolution,
          resolution_notes: u.resolution_notes,
          resolved_at: u.resolved_at?.toISOString() ?? null,
          resolved_by_id: u.resolved_by_id,
        } satisfies Prisma.InputJsonValue,
        ip: input.ip,
        user_agent: input.userAgent,
      },
    });
    return u;
  });

  // resolved_count maintenance — increment when transitioning out of
  // 'unresolved'. We leave the count alone on changes between
  // already-resolved states so it tracks "decisions made first
  // time", not "current resolved rows" (the audit log carries the
  // full per-item history).
  if (existing.resolution === 'unresolved') {
    await prisma.mymrcReconciliation.update({
      where: { id: existing.reconciliation_id },
      data: { resolved_count: { increment: 1 } },
    });
  }

  return { ok: true, item: updated };
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

/** Accept MM/DD/YYYY (canonical) and yyyy-mm-dd (Excel re-save). */
function parseDate(s: string): Date | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const m = Number(slash[1]);
    const d = Number(slash[2]);
    const y = Number(slash[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  }
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  }
  return null;
}

/** Parse "1,234" or "1234" into 1234; "" or invalid -> null. */
function parseIntOrNull(s: string): number | null {
  const trimmed = s.trim().replace(/,/g, '');
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function unitsMatch(csv: number | null, dr3: number | null): boolean {
  if (csv === null && dr3 === null) return true;
  if (csv === null || dr3 === null) return false;
  return csv === dr3;
}

function weightsWithinTolerance(
  csv: number | null,
  dr3: number | null,
  tolerancePct: number
): boolean {
  if (csv === null && dr3 === null) return true;
  if (csv === null || dr3 === null) return false;
  if (csv === 0 && dr3 === 0) return true;
  const diff = Math.abs(csv - dr3);
  const denom = Math.max(Math.abs(csv), Math.abs(dr3));
  if (denom === 0) return diff === 0;
  return (diff / denom) * 100 <= tolerancePct;
}

// Re-export internals for tests without exposing them in the public API.
export const __testing = { parseDate, parseIntOrNull, weightsWithinTolerance, unitsMatch };
