// ADR-0080 Phase 2 — the audit-COVERAGE read for the commodity tracker.
//
// ── What this read answers, and what it refuses to answer ───────────────────
// The Woodland Data Auditing Tracker carries NO tonnage and NO money (verified
// against the live bytes 2026-08-07, and again in `commodity-extract.ts`'s header).
// It is a coverage matrix: per commodity stream × month, was that month's audit
// against vendor invoices done, by whom, when — plus a second-audit trio.
//
// So the only honest number this module produces is a COUNT OF MONTHS. There is
// nothing here to compare against `processed_units_daily` (workbook-sync /
// ADR-0049 remains its one writer) and no dollar figure to reconcile. This module
// deliberately computes no divergence, flags no disagreement, and nominates no
// authoritative source — those rules are DEFERRED pending a stakeholder interview
// and are explicitly out of scope. A reconciliation rule invented here would be a
// guess wearing a total's clothing.
//
// ── THE VERSION PIN — the whole reason this file is not a `findMany` ────────
// Read `latestConfirmedVersionId` in `src/lib/equipment/terex-ledger.ts` first.
// It records the 2026-08-06 incident: registering TEREX.xlsx made all THREE
// applied revisions absorbable at once, the backlog sweep took all three, and the
// site-wide sum reported exactly 3 × the truth. Each per-version total was
// PERFECT; summing across versions is what was wrong.
//
// The same trap is live here and is arguably worse, because this document's unit
// is a COUNT. The unique key is
// `(doc_source_version_id, sheet_name, stream_label, month_label)`, so two
// confirmed revisions of one workbook coexist by design, each carrying a complete
// 84-row copy of the 2026 sheet. A read that aggregated every confirmed row for
// the site would report 168 months of coverage on a 12-month year — a number with
// no possible interpretation — and it would look like a bigger, better answer.
//
// So: pin the winning revision FIRST, then aggregate only inside it. Newest
// absorption wins, because a revision SUPERSEDES its predecessor rather than
// adding to it. This must not DEPEND on superseded batches having been discarded:
// a total that is only correct when somebody remembered to tidy up is not a
// guarantee, and the tests leave the older revisions CONFIRMED on purpose.
//
// ── "Not recorded" is not "no" — three buckets, never two ──────────────────
// `audited` is `boolean | null` and NULL means the sheet recorded no answer.
// Bucketing NULL with `false` would destroy the single most useful finding this
// document can produce: the months nobody has looked at. "We checked and it
// failed" and "nobody checked" are different operational facts with different
// owners. Every tally here is three-way and a test names each bucket.
//
// READ-ONLY. This module opens no write path of any kind.

import { prisma } from '@/lib/prisma';

/**
 * Which absorption state to read.
 *
 * NEVER a union of the two. Staged rows are an extraction nobody has accepted
 * (ADR-0080's preview-then-confirm gate); mixing them into a confirmed coverage
 * total would present a proposal as a fact — and because both states carry a
 * complete copy of the workbook, mixing them ALSO double-counts.
 */
export type CommodityScope = 'confirmed' | 'staged';

/** One stream × one month: the cell as the sheet recorded it. */
export interface CommodityCoverageCell {
  monthLabel: string;
  /** 1–12, or NULL when the verbatim label did not map. Never guessed. */
  monthNumber: number | null;
  /** TRUE / FALSE / NULL=NOT RECORDED. The three are never collapsed to two. */
  audited: boolean | null;
  initials: string | null;
  auditDateISO: string | null;
  /**
   * ALWAYS what the Date cell said. The live 2026 METAL block holds the literal
   * word "working" in March/April/May — a status, not a date. Surfaced verbatim
   * so the page can render it as written instead of inventing an audit date.
   */
  auditDateRaw: string | null;
  secondAudit: boolean | null;
  secondInitials: string | null;
  secondAuditDateISO: string | null;
  secondAuditDateRaw: string | null;
  /** 1-based source row in the sheet — provenance back to the document. */
  rowIndex: number;
}

/**
 * Three-way tally. `notRecorded` is a first-class answer, not a residue.
 *
 * Counted over ROWS, deliberately — not over the grid positions below. Inside one
 * pinned revision the two are identical, because
 * `(version, sheet, stream_label, month_label)` is UNIQUE. They diverge only when
 * the version pin has failed and a second revision's rows are in scope, and in
 * that case this count DOUBLES and says so, instead of being quietly absorbed by
 * a de-duplicating lookup that would render a plausible 12-month grid built from
 * two different revisions.
 */
export interface CoverageTally {
  audited: number;
  notAudited: number;
  /** `audited === null` — the sheet recorded nothing. NEVER folded into `notAudited`. */
  notRecorded: number;
  /** Rows tallied. Invariant: `audited + notAudited + notRecorded === rows`. */
  rows: number;
}

export interface CommodityStreamCoverage {
  streamGroup: string;
  streamLabel: string;
  /**
   * Aligned to the owning sheet's `monthLabels`. NULL = this stream has NO ROW
   * for that month at all, which is a different fact from an unrecorded answer
   * and is therefore never tallied as one.
   */
  cells: (CommodityCoverageCell | null)[];
  audit: CoverageTally;
  secondAudit: CoverageTally;
}

export interface CommoditySheetCoverage {
  sheetName: string;
  /** The sheet's own banner year. NULL when unreadable — never inferred. */
  sheetYear: number | null;
  /** The month axis: distinct labels across the sheet's streams, in order. */
  monthLabels: string[];
  streams: CommodityStreamCoverage[];
  audit: CoverageTally;
  secondAudit: CoverageTally;
}

export interface CommodityCoverage {
  scope: CommodityScope;
  /** The ONE revision these figures came from. NULL when the site has none. */
  versionId: string | null;
  absorbedAtISO: string | null;
  sheets: CommoditySheetCoverage[];
  audit: CoverageTally;
  secondAudit: CoverageTally;
  /** Rows inside the pinned revision. NOT rows for the site. */
  rowsConsidered: number;
  /**
   * True when the requested scope holds nothing — so a surface renders "awaiting
   * acceptance" rather than a clean grid of zero findings.
   */
  awaiting: boolean;
}

/** The row shape this module reads. Declared so the mapping is checked, not assumed. */
interface Row {
  sheet_name: string;
  sheet_year: number | null;
  stream_group: string;
  stream_label: string;
  month_label: string;
  month_number: number | null;
  audited: boolean | null;
  initials: string | null;
  audit_date: Date | null;
  audit_date_raw: string | null;
  second_audit: boolean | null;
  second_initials: string | null;
  second_audit_date: Date | null;
  second_audit_date_raw: string | null;
  row_index: number;
}

function emptyTally(): CoverageTally {
  return { audited: 0, notAudited: 0, notRecorded: 0, rows: 0 };
}

/**
 * Tally one three-way column.
 *
 * Written as an explicit three-branch switch rather than
 * `audited ? a : b` — a truthiness test silently sorts NULL into the `false`
 * bucket, which is precisely the defect this document's whole value depends on
 * not having.
 */
function tally(values: (boolean | null)[]): CoverageTally {
  const out = emptyTally();
  for (const v of values) {
    out.rows += 1;
    if (v === true) out.audited += 1;
    else if (v === false) out.notAudited += 1;
    else out.notRecorded += 1;
  }
  return out;
}

function addTally(a: CoverageTally, b: CoverageTally): CoverageTally {
  return {
    audited: a.audited + b.audited,
    notAudited: a.notAudited + b.notAudited,
    notRecorded: a.notRecorded + b.notRecorded,
    rows: a.rows + b.rows,
  };
}

function sumTallies(parts: CoverageTally[]): CoverageTally {
  return parts.reduce(addTally, emptyTally());
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString().slice(0, 10);
}

/**
 * The revision whose rows ARE this document right now, for one scope.
 *
 * Newest `absorbed_at` wins. Mirrors `latestConfirmedVersionId` in
 * `terex-ledger.ts` deliberately, down to the ordering clause, because the bug it
 * exists to stop is identical and a reader comparing the two should see the same
 * shape rather than a second invention.
 */
async function latestVersion(
  siteId: string,
  scope: CommodityScope,
): Promise<{ versionId: string; absorbedAt: Date } | null> {
  const newest = await prisma.docCommodityAuditRow.findFirst({
    where: { site_id: siteId, status: scope },
    orderBy: { absorbed_at: 'desc' },
    select: { doc_source_version_id: true, absorbed_at: true },
  });
  return newest
    ? { versionId: newest.doc_source_version_id, absorbedAt: newest.absorbed_at }
    : null;
}

/**
 * Order a sheet's month axis.
 *
 * By `monthNumber` where the label mapped, first-seen order otherwise — an
 * unmapped label ("June/July", the shape an operator writes when a month
 * boundary was audited in one pass) is kept and shown at the end rather than
 * being dropped or guessed into a position.
 */
function orderMonths(rows: Row[]): string[] {
  const seen = new Map<string, { n: number | null; at: number }>();
  rows.forEach((r, i) => {
    if (!seen.has(r.month_label)) seen.set(r.month_label, { n: r.month_number, at: i });
  });
  return [...seen.entries()]
    .sort(([, a], [, b]) => {
      if (a.n !== null && b.n !== null) return a.n - b.n;
      if (a.n !== null) return -1;
      if (b.n !== null) return 1;
      return a.at - b.at;
    })
    .map(([label]) => label);
}

function toCell(r: Row): CommodityCoverageCell {
  return {
    monthLabel: r.month_label,
    monthNumber: r.month_number,
    audited: r.audited,
    initials: r.initials,
    auditDateISO: iso(r.audit_date),
    auditDateRaw: r.audit_date_raw,
    secondAudit: r.second_audit,
    secondInitials: r.second_initials,
    secondAuditDateISO: iso(r.second_audit_date),
    secondAuditDateRaw: r.second_audit_date_raw,
    rowIndex: r.row_index,
  };
}

/** Group preserving first-seen order — the sheet's own stream order. */
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function buildSheet(sheetName: string, rows: Row[]): CommoditySheetCoverage {
  const monthLabels = orderMonths(rows);
  const byStream = groupBy(rows, (r) => r.stream_label);

  const streams: CommodityStreamCoverage[] = [...byStream.entries()].map(
    ([streamLabel, streamRows]) => {
      // The grid is a lookup (one position per month); the TALLIES are over the
      // raw rows. See `CoverageTally` — that asymmetry is the guard, not an
      // oversight.
      const byMonth = new Map(streamRows.map((r) => [r.month_label, toCell(r)]));
      return {
        streamGroup: streamRows[0]?.stream_group ?? '',
        streamLabel,
        cells: monthLabels.map((m) => byMonth.get(m) ?? null),
        audit: tally(streamRows.map((r) => r.audited)),
        secondAudit: tally(streamRows.map((r) => r.second_audit)),
      };
    },
  );

  return {
    sheetName,
    // The banner year of the sheet's own rows. Every row of a sheet carries the
    // same one; taking the first is a read, not a choice.
    sheetYear: rows[0]?.sheet_year ?? null,
    monthLabels,
    streams,
    audit: sumTallies(streams.map((s) => s.audit)),
    secondAudit: sumTallies(streams.map((s) => s.secondAudit)),
  };
}

export interface CoverageOptions {
  /** Defaults to `confirmed`. Staged rows are a proposal, never a total. */
  scope?: CommodityScope;
}

/**
 * Audit coverage for one site, from ONE revision of the workbook.
 *
 * The version pin happens before any aggregation and is not optional — see the
 * header. Callers get `versionId` back so a surface can state WHICH revision it
 * is showing rather than implying it is showing all of them.
 */
export async function computeCommodityCoverage(
  siteId: string,
  options: CoverageOptions = {},
): Promise<CommodityCoverage> {
  const scope = options.scope ?? 'confirmed';
  const pinned = await latestVersion(siteId, scope);

  if (pinned === null) {
    return {
      scope,
      versionId: null,
      absorbedAtISO: null,
      sheets: [],
      audit: emptyTally(),
      secondAudit: emptyTally(),
      rowsConsidered: 0,
      awaiting: true,
    };
  }

  const rows = (await prisma.docCommodityAuditRow.findMany({
    // SITE (hard rule #2), SCOPE, and ONE VERSION ONLY. Dropping the version
    // clause is the 168-months-in-a-12-month-year defect; a test falsifies it.
    where: {
      site_id: siteId,
      status: scope,
      doc_source_version_id: pinned.versionId,
    },
    orderBy: [{ sheet_name: 'asc' }, { row_index: 'asc' }],
    select: {
      sheet_name: true,
      sheet_year: true,
      stream_group: true,
      stream_label: true,
      month_label: true,
      month_number: true,
      audited: true,
      initials: true,
      audit_date: true,
      audit_date_raw: true,
      second_audit: true,
      second_initials: true,
      second_audit_date: true,
      second_audit_date_raw: true,
      row_index: true,
    },
  })) as Row[];

  const sheets = [...groupBy(rows, (r) => r.sheet_name).entries()]
    .map(([name, sheetRows]) => buildSheet(name, sheetRows))
    // Newest year first, unreadable-banner sheets last. Display order only — it
    // changes no count.
    .sort((a, b) => (b.sheetYear ?? -Infinity) - (a.sheetYear ?? -Infinity));

  return {
    scope,
    versionId: pinned.versionId,
    absorbedAtISO: pinned.absorbedAt.toISOString(),
    sheets,
    audit: sumTallies(sheets.map((s) => s.audit)),
    secondAudit: sumTallies(sheets.map((s) => s.secondAudit)),
    rowsConsidered: rows.length,
    awaiting: rows.length === 0,
  };
}

/** Sites with any absorbed commodity rows — the surface's site list. */
export async function sitesWithCommodityCoverage(): Promise<{ id: string; name: string }[]> {
  return prisma.site.findMany({
    where: { doc_commodity_audit_rows: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
