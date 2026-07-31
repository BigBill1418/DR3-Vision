// ADR-0049 D12 — daily-production adapter, FINALIZED onto the layout-aware parse.
//
// What changed (2026-07-30) and why it mattered
// ─────────────────────────────────────────────
// This file used to match a sheet named exactly `daily` and read FIXED columns
// A–G. No real Woodland workbook has that sheet, so against Kelsey's file it
// produced either zero rows (silent) or — worse — whatever happened to sit in
// A–G mapped into `processed_units_daily` under workbook-wins semantics, i.e. a
// guessed column overwriting a real production figure.
//
// The layout-aware machinery already existed and already ran on the same bytes:
// `parseWorkbook` (ADR-0039/0048) classifies every sheet by MEANING via
// `section-resolver.ts` (row-2 section label → header signature → prefix-stripped
// name), extracts the Processed sheet's per-day close through
// `section-extractors.ts`, and tags each row with tab/row/column provenance. The
// engine called it and threw all of it away except `templateGeneration`, which it
// printed in a log line. This adapter now DERIVES its rows from that parse and
// resolves no columns of its own.
//
// Column resolution now:
//   `parseWorkbook` → StagingRow[] where `section === 'daily_close'`, one per
//   "Day N" row on the semantically-resolved Processed sheet, carrying a JSON
//   payload with the workbook's own values + provenance. This adapter DECODES
//   that payload. It never addresses a cell, a column letter or a sheet name.
//
// Refusal posture — a zero must never be mistaken for a fact:
//   - `templateGeneration === 'unknown'`  → refuse (we do not know this shape).
//   - Processed section never resolved     → refuse (layout unreadable).
//   - Days present but ALL unusable        → refuse (loud, with per-day reasons).
//   - Conflicting duplicate day keys       → refuse (picking one would be a guess).
//   - Processed section resolved, no days  → NOT a failure: an empty month.
// A refusal returns `failure` — the engine turns it into a FAILED run with the
// reason on `workbook_sync_runs.error_text` and writes NOTHING. "Cannot read" and
// "no data" are different outcomes with different messages, by design.

import {
  parseWorkbook,
  type CellProvenance,
  type ParsedWorkbook,
  type StagingRow,
  type TemplateGeneration,
} from '@/lib/audit/workbook/parser';
import type { SiteAliasResolver } from '@/lib/audit/types';

/** The staging section the semantic extractor tags each Processed "Day N" row with. */
const DAILY_CLOSE_SECTION = 'daily_close';

/**
 * `sectionCounts` key the extractor bumps for EVERY scanned Processed sheet —
 * including one that yielded 0 day rows. Its presence is therefore the
 * discriminator between "no data" (key present, value 0) and "layout unreadable"
 * (key absent: no Processed sheet resolved, or the workbook month could not be
 * derived so the day rows were never built).
 */
const PROCESSED_SECTION_COUNT_KEY = 'processed_daily_close';

/**
 * `sectionCounts` keys the extractor bumps INSTEAD of building day rows when it
 * refused for a NAMED reason (ADR-0049 Am.3). Each maps to its own refusal so the
 * ledger says which one happened — "cannot read" is not one fact, it is four.
 */
const COLUMNS_UNRECOGNISED_COUNT_KEY = 'processed_columns_unrecognised';
const MONTH_MISMATCH_COUNT_KEY = 'processed_month_mismatch';
const MONTH_UNDETERMINABLE_COUNT_KEY = 'processed_month_undeterminable';

export interface DailyProductionRow {
  /** 'YYYY-MM-DD' (UTC day key) — the (site, production_date) upsert key. */
  productionDate: string;
  strippedProgram: number;
  strippedNonProgram: number;
  /**
   * ADR-0049 Am.3 A1 — TRUE when the sheet left the non-program cell BLANK on a
   * row that is otherwise a complete close, and this 0 is our inference of "none"
   * rather than a figure the sheet stated. Carried into the audit row so the
   * provenance never claims the workbook said zero when it said nothing.
   */
  strippedNonProgramInferred: boolean;
  materialTicketNumber: string | null;
  savedUnits: number | null;
  // NOTE — there is deliberately no `employeesCount` / `processorsCount` here.
  // The real Processed sheet carries no such column (Am.1 D12d), so the adapter
  // could only ever report null, and under ADR-0049 D13 the sync never writes
  // those fields. Carrying a field that is always null and never written is an
  // invitation for a future reader to wire it up.
}

/** Why a day the workbook DOES carry was not turned into a production row. */
export type DailySkipReason =
  | 'date_unreadable'
  | 'stripped_program_unusable'
  | 'stripped_non_program_unusable'
  | 'date_outside_file_month';

export interface DailySkippedDay {
  /** The workbook's own row key ("day_7") — never a fabricated date. */
  label: string;
  reason: DailySkipReason;
  provenance: CellProvenance;
}

export type DailyFailureKind =
  | 'unknown_template_generation'
  | 'daily_section_unresolved'
  | 'processed_columns_unrecognised'
  | 'month_mismatch'
  | 'month_undeterminable'
  | 'all_days_unusable'
  | 'conflicting_duplicate_days'
  | 'wrong_site';

export interface DailyParseFailure {
  kind: DailyFailureKind;
  /** Operator-facing; goes verbatim onto `workbook_sync_runs.error_text`. */
  message: string;
  /**
   * TRUE when nothing is WRONG — the workbook simply does not carry enough yet to
   * date its close rows (ADR-0049 Am.3 A2). The engine records these as `skipped`
   * and does NOT page: paging an operator because Kelsey has not logged the
   * month's first inbound load yet fails ADR-0037 Q1 (nothing is actionable) and
   * Q2 (nothing is customer-visible). A refusal (`false`) is a real read failure.
   */
  notEnoughData: boolean;
}

export interface DailyParseResult {
  rows: DailyProductionRow[];
  /**
   * Rows present on the sheet but skipped this poll because a required figure
   * was missing or unusable (D11) — retried next poll, NO alert. Equals
   * `skipped.length`; kept as a named field because the run ledger column
   * (`rows_skipped_midedit`) is this number.
   */
  midEditCount: number;
  /** Per-day detail behind `midEditCount` (which day, which figure, which cell). */
  skipped: DailySkippedDay[];
  /** Straight from the shared parse — no longer decorative: it gates the refusal. */
  templateGeneration: TemplateGeneration;
  /** `daily_close` rows the layout-aware parse resolved (0 with no failure = empty month). */
  daysSeen: number;
  /** Non-null ⇒ the workbook was NOT read. The caller must write nothing and fail the run. */
  failure: DailyParseFailure | null;
}

/**
 * Optional wrong-workbook cross-check. The engine binds `site_id` from the
 * `workbook_sources` row, so a mis-pointed `folder_path` / `naming_pattern` would
 * write ANOTHER site's figures under this site's key with no complaint. When the
 * workbook's own source names resolve (via `source_aliases`, so spelling drift is
 * tolerated) and EVERY resolvable one belongs to a different site, that is
 * affirmative evidence of the wrong file — refuse.
 */
export interface DailySiteScope {
  siteId: string;
  resolver: SiteAliasResolver;
}

// ── payload decoding (strict — a value is used only if it is unambiguously usable) ──

function payloadOf(row: StagingRow): Record<string, unknown> | null {
  if (row.rawValue === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.rawValue);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A real calendar day in 'YYYY-MM-DD' form — rejects '2026-02-31' and friends. */
function dayKey(payload: Record<string, unknown>): string | null {
  const raw = payload['date'];
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : null;
}

/** A finite, non-negative number, or null. A negative production figure is not usable. */
function quantity(payload: Record<string, unknown>, key: string): number | null {
  const raw = payload[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * TRUE when the sheet's cell was BLANK — the extractor omits the key entirely
 * rather than emitting a value it did not read. Distinct from a key that is
 * present and unusable (a negative, a string, NaN): that is a figure we cannot
 * trust, and it skips the day. Only a genuine blank can be read as "none".
 */
function stated(payload: Record<string, unknown>, key: string): boolean {
  return key in payload;
}

function text(payload: Record<string, unknown>, key: string): string | null {
  const raw = payload[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function sameRow(a: DailyProductionRow, b: DailyProductionRow): boolean {
  return (
    a.strippedProgram === b.strippedProgram &&
    a.strippedNonProgram === b.strippedNonProgram &&
    a.materialTicketNumber === b.materialTicketNumber &&
    a.savedUnits === b.savedUnits
  );
}

function at(p: CellProvenance): string {
  return `${p.tab}!${p.col}${p.row}`;
}

/** The parse flags that explain a Processed-sheet miss, for the refusal message. */
function processedFlags(parsed: ParsedWorkbook): string {
  const relevant = parsed.flags.filter((f) => f.startsWith('[processed]'));
  return relevant.length > 0 ? ` Parser notes: ${relevant.join(' | ')}` : '';
}

function sheetSummary(parsed: ParsedWorkbook): string {
  const types = [...parsed.sheetTypes.entries()].map(([name, type]) => `${name}=${type}`);
  return types.length > 0 ? types.join(', ') : '(no sheets classified)';
}

/**
 * Per-day `Saved` units, keyed by day-of-month, read from the DAY sheets' own
 * labelled "Saved" cell (`inventorySeries`) — the same figure ADR-0037 §A.2
 * defines as set-aside-not-processed, which is exactly what
 * `processed_units_daily.saved_units` stores. Days without the label are absent
 * from the map, never 0.
 */
function savedByDayOfMonth(parsed: ParsedWorkbook): Map<number, number> {
  const out = new Map<number, number>();
  for (const day of parsed.inventorySeries) {
    if (day.saved !== null && Number.isFinite(day.saved) && day.saved >= 0) {
      out.set(day.day, day.saved);
    }
  }
  return out;
}

/**
 * Refuse when every source name the workbook resolves belongs to a DIFFERENT
 * site. Unresolvable names prove nothing (they are the promotion's problem) and
 * a single in-site match clears the check — this fires only on affirmative
 * evidence that the file belongs to another site.
 */
function wrongSite(parsed: ParsedWorkbook, scope: DailySiteScope): string | null {
  const foreign = new Map<string, string>();
  let matched = 0;
  for (const row of parsed.stagingRows) {
    if (row.siteNameRaw === null) continue;
    const hit = scope.resolver.resolve(row.siteNameRaw);
    if (hit === null) continue;
    if (hit.siteId === scope.siteId) matched += 1;
    else foreign.set(row.siteNameRaw, hit.siteId);
  }
  if (matched > 0 || foreign.size === 0) return null;
  const examples = [...foreign.entries()]
    .slice(0, 5)
    .map(([name, siteId]) => `"${name}" → site ${siteId}`)
    .join(', ');
  return (
    `every source name resolved in this workbook belongs to a DIFFERENT site ` +
    `(configured site is ${scope.siteId}; ${foreign.size} foreign name(s): ${examples}). ` +
    `Refusing to write another site's figures under this site's key — check the ` +
    `workbook source's drive_upn / folder_path / naming_pattern. Nothing was written.`
  );
}

// ── the adapter ────────────────────────────────────────────────────────────

/**
 * Derive the per-day production rows from an ALREADY-PARSED workbook.
 *
 * Pure and synchronous: the caller owns the (single) `parseWorkbook` call, so the
 * bytes are parsed once per poll and the same `ParsedWorkbook` drives both the
 * staging/provenance record and these operational rows.
 */
export function deriveDailyRows(
  parsed: ParsedWorkbook,
  siteScope?: DailySiteScope,
  expectedMonth?: string | null,
): DailyParseResult {
  const base = {
    rows: [] as DailyProductionRow[],
    midEditCount: 0,
    skipped: [] as DailySkippedDay[],
    templateGeneration: parsed.templateGeneration,
    daysSeen: 0,
  };
  const refuse = (kind: DailyFailureKind, message: string): DailyParseResult => ({
    ...base,
    failure: { kind, message, notEnoughData: false },
  });

  // (1) A shape we do not recognise is never parsed hopefully.
  if (parsed.templateGeneration === 'unknown') {
    return refuse(
      'unknown_template_generation',
      `templateGeneration is "unknown" — no Woodland daily-log section resolved in this ` +
        `workbook (${parsed.sheetCount} sheet(s): ${sheetSummary(parsed)}). Refusing to parse ` +
        `a shape the parser does not recognise. Nothing was written.`,
    );
  }

  if (siteScope) {
    const mismatch = wrongSite(parsed, siteScope);
    if (mismatch !== null) return refuse('wrong_site', mismatch);
  }

  // (1b) The extractor settled the MONTH and the COLUMNS before it built a single
  //      close row (ADR-0049 Am.3 A2/A3). When it refused, it bumped a named count
  //      key instead — so day rows are absent for a reason that is NOT "empty
  //      month", and each reason gets its own message. These are checked before
  //      the zero-rows branch precisely because they LOOK like an empty month.
  if (MONTH_MISMATCH_COUNT_KEY in parsed.sectionCounts) {
    return refuse(
      'month_mismatch',
      `the month the workbook's own dated rows imply does NOT match the month the FILE NAME ` +
        `states${expectedMonth ? ` (${expectedMonth})` : ''}. Every "Day N" close row would have ` +
        `been dated into the wrong month, overwriting a month that may already be closed and ` +
        `billed. Nothing was written.${processedFlags(parsed)}`,
    );
  }
  if (COLUMNS_UNRECOGNISED_COUNT_KEY in parsed.sectionCounts) {
    return refuse(
      'processed_columns_unrecognised',
      `the Processed sheet's stripped program / non-program columns could not be resolved from ` +
        `its header band, so the billed figures could not be read from named columns. Refusing ` +
        `to fall back to fixed column positions — a shifted column yields plausible WRONG ` +
        `figures that nothing downstream can detect. Nothing was written.${processedFlags(parsed)}`,
    );
  }
  if (MONTH_UNDETERMINABLE_COUNT_KEY in parsed.sectionCounts) {
    return {
      ...base,
      failure: {
        kind: 'month_undeterminable',
        message:
          `the workbook month could not be settled — the file carries no dated inbound row yet ` +
          `and no month was supplied from the file name, so "Day N" cannot be turned into a ` +
          `date. This is "not enough data yet", not a fault: it clears itself as soon as the ` +
          `month's first inbound load is recorded. Nothing was written.${processedFlags(parsed)}`,
        notEnoughData: true,
      },
    };
  }

  const dayRows = parsed.stagingRows.filter((r) => r.section === DAILY_CLOSE_SECTION);
  const processedSectionResolved = PROCESSED_SECTION_COUNT_KEY in parsed.sectionCounts;

  // (2) No day rows at all: an empty month (section resolved) vs an unreadable
  //     layout (section never resolved). Two outcomes, two messages.
  if (dayRows.length === 0) {
    if (!processedSectionResolved) {
      return {
        ...base,
        failure: {
          kind: 'daily_section_unresolved',
          message:
            `no daily-production section could be resolved (templateGeneration=` +
            `"${parsed.templateGeneration}", ${parsed.stagingRows.length} staging row(s) from ` +
            `${parsed.sheetCount} sheet(s): ${sheetSummary(parsed)}). The workbook has content ` +
            `but its Processed/daily-close layout was not recognised, so zero rows here means ` +
            `"cannot read", not "no production". Nothing was written.${processedFlags(parsed)}`,
          notEnoughData: false,
        },
      };
    }
    return { ...base, failure: null }; // legitimately empty month — not an error
  }

  // (3) Decode each day. A day missing a required figure is SKIPPED + COUNTED,
  //     never defaulted.
  const saved = savedByDayOfMonth(parsed);
  const byDate = new Map<string, DailyProductionRow>();
  const skipped: DailySkippedDay[] = [];
  const conflicts: string[] = [];

  for (const stagingRow of dayRows) {
    const label = stagingRow.fieldKey ?? `row_${stagingRow.rowIndex}`;
    const payload = payloadOf(stagingRow);
    const productionDate = payload === null ? null : dayKey(payload);
    if (payload === null || productionDate === null) {
      skipped.push({ label, reason: 'date_unreadable', provenance: stagingRow.provenance });
      continue;
    }
    const strippedProgram = quantity(payload, 'strippedProgram');
    if (strippedProgram === null) {
      skipped.push({
        label,
        reason: 'stripped_program_unusable',
        provenance: stagingRow.provenance,
      });
      continue;
    }
    // ADR-0049 Am.3 A1 — a BLANK non-program cell on a row that is otherwise a
    // complete close means NONE, and is read as 0.
    //
    // Amendment 1 removed the extractor's `snp ?? 0`, which was right: a
    // manufactured zero on `stripped_program` is a fabricated billed figure. But
    // applying the same rule to `stripped_non_program` refuses Kelsey's real June
    // workbook in full — measured 2026-07-31 against the archived bytes, column E
    // is blank on all 23 days (June had no non-program stripping and it is left
    // empty rather than typed as 0), which produced 0 rows and `all_days_unusable`.
    // With `is_syncing` on that is a refusal every 10 minutes, forever.
    //
    // Those same 23 days match MyMRC at delta 0.0 on all 23 and cross-foot exactly
    // to the workbook's own Processed SUM-row D total of 17126. The days are real
    // and complete; their non-program value is genuinely none. So:
    //   - blank `strippedProgram`      → the day is genuinely unusable. SKIP.
    //   - blank `strippedNonProgram` on a row whose `strippedProgram` IS present
    //                                  → none. 0, MARKED AS INFERRED.
    //   - PRESENT but unusable (negative, non-numeric) → still a skip. A figure we
    //     cannot trust is not the same fact as a cell left empty.
    const nonProgramStated = stated(payload, 'strippedNonProgram');
    const strippedNonProgram = nonProgramStated ? quantity(payload, 'strippedNonProgram') : 0;
    if (strippedNonProgram === null) {
      skipped.push({
        label,
        reason: 'stripped_non_program_unusable',
        provenance: stagingRow.provenance,
      });
      continue;
    }

    // ADR-0049 Am.3 A2 — a close row dated outside the file's own month is never
    // written. The month is settled once for the whole workbook, so this is
    // defence in depth against a future path that dates rows individually.
    if (expectedMonth != null && productionDate.slice(0, 7) !== expectedMonth) {
      skipped.push({
        label,
        reason: 'date_outside_file_month',
        provenance: stagingRow.provenance,
      });
      continue;
    }

    const dayOfMonth = Number(productionDate.slice(8, 10));
    const row: DailyProductionRow = {
      productionDate,
      strippedProgram,
      strippedNonProgram,
      strippedNonProgramInferred: !nonProgramStated,
      materialTicketNumber: text(payload, 'materialTicketNumber'),
      savedUnits: quantity(payload, 'savedUnits') ?? saved.get(dayOfMonth) ?? null,
    };

    const prior = byDate.get(productionDate);
    if (prior && !sameRow(prior, row)) {
      conflicts.push(`${productionDate} (${at(stagingRow.provenance)})`);
      continue;
    }
    byDate.set(productionDate, row);
  }

  // (4) Two day rows disagreeing about the same date: picking one is a guess.
  if (conflicts.length > 0) {
    return {
      ...base,
      daysSeen: dayRows.length,
      skipped,
      midEditCount: skipped.length,
      failure: {
        kind: 'conflicting_duplicate_days',
        message:
          `${conflicts.length} production date(s) appear more than once with DIFFERENT figures: ` +
          `${conflicts.slice(0, 5).join('; ')}. Choosing one would be a guess. Nothing was written.`,
        notEnoughData: false,
      },
    };
  }

  const rows = [...byDate.values()].sort((a, b) =>
    a.productionDate.localeCompare(b.productionDate),
  );

  // (5) The workbook clearly carries days, yet not one produced a figure. That is
  //     a read failure, not a clean run of zero.
  if (rows.length === 0) {
    const reasons = skipped
      .slice(0, 5)
      .map((s) => `${s.label} ${s.reason} @ ${at(s.provenance)}`)
      .join('; ');
    return {
      ...base,
      daysSeen: dayRows.length,
      skipped,
      midEditCount: skipped.length,
      failure: {
        kind: 'all_days_unusable',
        message:
          `${dayRows.length} daily-close row(s) were found but NONE produced a usable production ` +
          `figure — first ${Math.min(skipped.length, 5)}: ${reasons}. Zero rows here means ` +
          `"cannot read", not "no production". Nothing was written.`,
        notEnoughData: false,
      },
    };
  }

  return {
    rows,
    midEditCount: skipped.length,
    skipped,
    templateGeneration: parsed.templateGeneration,
    daysSeen: dayRows.length,
    failure: null,
  };
}

/**
 * Parse `data` and derive its daily-production rows. Convenience wrapper — the
 * sync engine calls {@link deriveDailyRows} directly with the `ParsedWorkbook` it
 * already holds, so production parses the bytes exactly once.
 */
export async function parseDailyRows(
  data: Uint8Array | ArrayBuffer | Buffer,
  siteScope?: DailySiteScope,
  expectedMonth?: string | null,
): Promise<DailyParseResult> {
  return deriveDailyRows(
    await parseWorkbook(data, { expectedMonth: expectedMonth ?? null }),
    siteScope,
    expectedMonth ?? null,
  );
}
