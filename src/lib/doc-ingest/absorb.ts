// ADR-0069 — the ABSORPTION BRIDGE: turn an archived document into REFERENCE rows.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THE ONE-WRITER RULE                                                       │
// │                                                                           │
// │ `src/lib/workbook-sync/` (ADR-0049) is the system of record for           │
// │ `processed_units_daily`. NOTHING in this file writes that table, and      │
// │ nothing in this file may ever be changed to. Not "upsert when             │
// │ workbook-sync hasn't". Not "write with a source discriminator so both can  │
// │ own it". One writer. This module writes `doc_reference_rows` — a          │
// │ different table with a different meaning — and the reconciliation read    │
// │ compares the two.                                                         │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── Why re-read the R2 bytes instead of using `parse_summary` ───────────────
// `parse_summary` is a SHAPE projection: sheet names, a header guess, row counts,
// per-header sums, and a text sample built from headers only. It retains no cell
// value from any row. The 2026-07-30 audit measured this on all three live
// documents — one has an empty `numericTotals`, one has a single sum of
// identifiers, one has 40 sheets of title strings. It cannot answer an operational
// question and extending it to try would break the one job it does well (revision-
// over-revision change detection). So the archived object is the only source, and
// the layout-aware parsers are the only readers.
//
// ── Why the layout-aware parser, not parse.ts ──────────────────────────────
// `parse.ts` takes the first non-empty row as the header row. That is wrong on 3 of
// 3 live workbooks — every real one opens with a merged title row — so anything
// built on its `headers[]` would be built on sand. `parseWorkbook`
// (`@/lib/audit/workbook/parser`) has a real layout resolver spanning at least
// three template generations, and `parseDailyRows` derives the per-day rows.
//
// ── Why exercising `parseDailyRows` here is SAFE, and useful ────────────────
// `parseDailyRows` derives its rows from the SAME layout-aware parse (ADR-0049
// D12, finalized 2026-07-30): it decodes the semantic extractor's `daily_close`
// staging rows and resolves no columns of its own. It still meets real workbooks
// it cannot read — a template generation the parser does not recognise, a
// Processed layout that does not resolve — and it reports that as a REFUSAL with
// a reason rather than as rows. Here the blast radius of such a file is a
// reference row and a loud anomaly; the reconciliation screen is precisely how a
// mismatch gets DISCOVERED, at zero operational cost, before workbook-sync is
// ever allowed to write production.
//
// ── Failure is loud, in both directions ────────────────────────────────────
// - Zero usable rows raises `absorption_empty`. It is never recorded as a
//   successful absorption of nothing. The history of this module is silent zeroes
//   (a null ctag read as "unchanged", a missing baseline read as "no variance", a
//   failed archive read as "applied") and this is the line that refuses to add one.
// - A NULL `site_id` raises `absorption_refused` and writes nothing. A NULL site is
//   UNCLASSIFIED, never "both" and never a guess (hard rule #2). The refusal does
//   NOT latch `absorbed_at`, so it re-attempts for free the moment Bill confirms
//   the site — the operator action fixes it with no re-trigger needed.

import {
  Prisma,
  type PrismaClient,
  type DocSource,
  type DocSourceVersion,
  type DocReferenceMetric,
} from '@prisma/client';
import { getFileDropBytes } from '@/lib/r2';
import { writeAudit } from '@/lib/audit';
import { parseWorkbook } from '@/lib/audit/workbook/parser';
import {
  parseDailyRows,
  type DailyParseResult,
  type DailyProductionRow,
} from '@/lib/workbook-sync/daily-adapter';
import { raiseAnomaly, resolveAnomaly } from './anomalies';
import { sourceKey } from './discovery';

/** Audit actor for absorption writes. Mirrors the ingest pipeline's label. */
export const ABSORB_ACTOR = 'system:doc-ingest:absorb';

/**
 * Document classes this bridge can extract typed rows from.
 *
 * Deliberately a one-entry set rather than a `switch` with a `default` that
 * guesses. A kind is absorbable only when a REAL, TESTED extractor exists for it;
 * anything else records `not_absorbable` and moves on, which is honest. Adding a
 * kind here means adding an extractor below and a metric mapping — not loosening a
 * condition.
 */
export const ABSORBABLE_KINDS = new Set<string>(['daily_log_workbook']);

export type AbsorbOutcome =
  /** Reference rows were written. */
  | 'absorbed'
  /** Not a kind this bridge extracts. Not a failure. */
  | 'not_absorbable'
  /** Confirmed absorbable, but `site_id` is NULL. Refused, loudly. */
  | 'refused_unclassified_site'
  /** The extractor ran and produced no usable rows. Raised as an anomaly. */
  | 'empty'
  /** The archived bytes could not be read or parsed. Raised as an anomaly. */
  | 'unreadable';

export interface AbsorbResult {
  versionId: string;
  outcome: AbsorbOutcome;
  rowsWritten: number;
  /** Days covered by the written rows — the reconciliation's coverage window. */
  datesCovered: number;
  /** Operator-actionable reason, when the outcome is not `absorbed`. */
  reason: string | null;
  anomaliesRaised: number;
}

export interface AbsorbDeps {
  /** Server-side R2 GET. Injected so tests never touch object storage. */
  getBytes?: (storageKey: string) => Promise<Uint8Array | null>;
  /** The per-day row extractor (ADR-0049 D12 seam). Injected for tests. */
  parseRows?: typeof parseDailyRows;
  /** The layout-aware workbook parser, used for template-generation provenance. */
  parseLayout?: typeof parseWorkbook;
  now?: Date;
}

/**
 * Map one extracted daily row onto reference rows.
 *
 * Every metric emitted here names a real `processed_units_daily` column — that is
 * the invariant that makes the reconciliation total (a metric with no counterpart
 * column could be extracted but never compared). `savedUnits` is omitted when the
 * workbook did not state one: an absent figure is not a zero, and recording it as
 * zero would manufacture a disagreement with a Vision row that is also absent.
 */
function toReferenceValues(
  row: DailyProductionRow,
): Array<{ metric: DocReferenceMetric; value: number }> {
  const out: Array<{ metric: DocReferenceMetric; value: number }> = [
    { metric: 'stripped_program', value: row.strippedProgram },
    { metric: 'stripped_non_program', value: row.strippedNonProgram },
  ];
  if (row.savedUnits !== null) out.push({ metric: 'saved_units', value: row.savedUnits });
  return out;
}

/**
 * Absorb ONE applied revision into `doc_reference_rows`.
 *
 * Idempotent: the write deletes this revision's existing reference rows and
 * rewrites them inside a single transaction, so a re-run replaces rather than
 * duplicates, and a partial failure leaves no half-absorbed revision.
 */
export async function absorbVersion(
  prisma: PrismaClient,
  source: DocSource,
  version: DocSourceVersion,
  deps: AbsorbDeps = {},
): Promise<AbsorbResult> {
  const now = deps.now ?? new Date();
  const getBytes = deps.getBytes ?? getFileDropBytes;
  const parseRows = deps.parseRows ?? parseDailyRows;
  const parseLayout = deps.parseLayout ?? parseWorkbook;
  const subject = sourceKey(source.drive_id, source.item_id);

  // ── Gate 1: is this a kind we have a real extractor for? ──────────────────
  if (source.doc_class === null || !ABSORBABLE_KINDS.has(source.doc_class)) {
    return finishTerminal(
      prisma,
      version,
      {
        versionId: version.id,
        outcome: 'not_absorbable',
        rowsWritten: 0,
        datesCovered: 0,
        reason:
          source.doc_class === null
            ? 'Not yet confirmed — a document class must be confirmed before it can be absorbed.'
            : `No reference extractor exists for document class "${source.doc_class}".`,
        anomaliesRaised: 0,
      },
      now,
    );
  }

  // ── Gate 2: HARD RULE #2. A NULL site is UNCLASSIFIED, never a guess. ─────
  // This runs BEFORE the download on purpose: refusing costs one row read, so an
  // unconfirmed document never burns an R2 GET and a parse on every sweep.
  if (source.site_id === null) {
    const reason =
      `"${source.display_name}" is confirmed as a ${source.doc_class} but has NO SITE. A document ` +
      `without a site is UNCLASSIFIED, not cross-site, so its figures cannot be attributed and ` +
      `absorption is REFUSED. Set the site on the confirm queue and it will absorb on the next sweep.`;
    const res = await raiseAnomaly(prisma, {
      kind: 'absorption_refused',
      subject,
      docSourceId: source.id,
      docSourceVersionId: version.id,
      detail: reason,
      context: { docClass: source.doc_class, versionId: version.id },
      now,
    });
    // NOT terminal: deliberately leaves `absorbed_at` NULL so confirming the site
    // is the whole fix. Only the status/reason are recorded.
    await prisma.docSourceVersion.update({
      where: { id: version.id },
      data: {
        absorption_status: 'refused_unclassified_site',
        absorption_error: reason,
        absorption_rows: 0,
      },
    });
    return {
      versionId: version.id,
      outcome: 'refused_unclassified_site',
      rowsWritten: 0,
      datesCovered: 0,
      reason,
      anomaliesRaised: res.raised ? 1 : 0,
    };
  }

  const siteId = source.site_id;

  // ── Gate 3: the bytes. `parse_summary` keeps no cell values, so a missing ──
  // archive means the content of this revision does not exist anywhere.
  let bytes: Uint8Array | null = null;
  let readError: string | null = null;
  if (!version.r2_key) {
    readError =
      `"${source.display_name}" has no archived object for this revision, and the stored summary ` +
      `retains no cell values — so there is nothing to extract from. Re-ingest once R2 storage is available.`;
  } else {
    try {
      bytes = await getBytes(version.r2_key);
      if (!bytes) {
        readError =
          `"${source.display_name}" could not be read back from archival storage (key present, object ` +
          `not retrievable). Check the R2 configuration.`;
      }
    } catch (e) {
      readError = `"${source.display_name}" could not be read back from archival storage: ${describe(e)}`;
    }
  }

  if (readError !== null || bytes === null) {
    const reason = readError ?? 'Archived bytes unavailable.';
    const res = await raiseAnomaly(prisma, {
      kind: 'absorption_empty',
      subject,
      docSourceId: source.id,
      docSourceVersionId: version.id,
      detail: reason,
      context: { versionId: version.id, r2Key: version.r2_key },
      now,
    });
    return finishTerminal(
      prisma,
      version,
      {
        versionId: version.id,
        outcome: 'unreadable',
        rowsWritten: 0,
        datesCovered: 0,
        reason,
        anomaliesRaised: res.raised ? 1 : 0,
      },
      now,
    );
  }

  // ── Extract ───────────────────────────────────────────────────────────────
  // `parseWorkbook` gives the template generation + sheet names, which is what
  // turns "produced nothing" into a diagnosable message naming what WAS in the
  // file. `parseDailyRows` derives the operational per-day rows.
  let templateGeneration = 'unknown';
  let sheetNames: string[] = [];
  let daily: DailyParseResult;
  try {
    const layout = await parseLayout(bytes);
    templateGeneration = layout.templateGeneration;
    sheetNames = [...layout.sheetTypes.keys()];
    daily = await parseRows(bytes);
  } catch (e) {
    const reason =
      `"${source.display_name}" is registered as a ${source.doc_class} but could not be parsed as one: ` +
      `${describe(e)}`;
    const res = await raiseAnomaly(prisma, {
      kind: 'absorption_empty',
      subject,
      docSourceId: source.id,
      docSourceVersionId: version.id,
      detail: reason,
      context: { versionId: version.id },
      now,
    });
    return finishTerminal(
      prisma,
      version,
      {
        versionId: version.id,
        outcome: 'unreadable',
        rowsWritten: 0,
        datesCovered: 0,
        reason,
        anomaliesRaised: res.raised ? 1 : 0,
      },
      now,
    );
  }

  // ── THE LOUD ZERO ─────────────────────────────────────────────────────────
  // Zero rows is not "the document was empty". Either the adapter REFUSED the
  // file (it says why, and that reason is the operator's answer), or it read the
  // file and every day was unusable. The detail line names what the parser DID
  // see, so the next person does not have to re-derive it.
  if (daily.rows.length === 0) {
    const cause =
      daily.failure !== null
        ? `The daily adapter REFUSED this workbook (${daily.failure.kind}): ${daily.failure.message}`
        : `The daily adapter read this workbook without refusing it and found ${daily.daysSeen} ` +
          `daily-close row(s), none of which produced a usable figure.`;
    const reason =
      `"${source.display_name}" is confirmed as a ${source.doc_class}, was read successfully, and ` +
      `produced ZERO usable daily rows. This is NOT evidence the document is empty. ${cause} ` +
      `Template generation read as "${templateGeneration}"; sheets present: ` +
      `${sheetNames.length > 0 ? sheetNames.join(', ') : '(none classified)'}. ` +
      `${daily.midEditCount} row(s) were skipped as mid-edit.`;
    const res = await raiseAnomaly(prisma, {
      kind: 'absorption_empty',
      subject,
      docSourceId: source.id,
      docSourceVersionId: version.id,
      detail: reason,
      context: {
        versionId: version.id,
        templateGeneration,
        sheetNames,
        midEditCount: daily.midEditCount,
      },
      now,
    });
    return finishTerminal(
      prisma,
      version,
      {
        versionId: version.id,
        outcome: 'empty',
        rowsWritten: 0,
        datesCovered: 0,
        reason,
        anomaliesRaised: res.raised ? 1 : 0,
      },
      now,
    );
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  const records: Prisma.DocReferenceRowCreateManyInput[] = [];
  for (const row of daily.rows) {
    const productionDate = new Date(`${row.productionDate}T00:00:00.000Z`);
    for (const { metric, value } of toReferenceValues(row)) {
      records.push({
        doc_source_id: source.id,
        doc_source_version_id: version.id,
        site_id: siteId,
        production_date: productionDate,
        metric,
        value: new Prisma.Decimal(value),
        source_sheet: 'daily',
        extracted_at: now,
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    // Replace, never accumulate: a re-absorb of the same revision must produce
    // the same rows, not a second set.
    await tx.docReferenceRow.deleteMany({ where: { doc_source_version_id: version.id } });
    await tx.docReferenceRow.createMany({ data: records });
    await tx.docSourceVersion.update({
      where: { id: version.id },
      data: {
        absorbed_at: now,
        absorption_status: 'absorbed',
        absorption_rows: records.length,
        absorption_error: null,
      },
    });
    await writeAudit(
      {
        actor_label: ABSORB_ACTOR,
        action: 'insert',
        table_name: 'doc_reference_rows',
        row_id: version.id,
        after: {
          doc_source_id: source.id,
          site_id: siteId,
          rows: records.length,
          days: daily.rows.length,
          mid_edit_skipped: daily.midEditCount,
          template_generation: templateGeneration,
          // Stated explicitly in the audit trail because it is the property that
          // makes this write safe to have happened at all.
          reference_only: true,
        },
      },
      { tx },
    );
  });

  await resolveAnomaly(
    prisma,
    'absorption_empty',
    subject,
    `Absorption produced ${records.length} reference row(s) across ${daily.rows.length} day(s).`,
    now,
  );
  await resolveAnomaly(
    prisma,
    'absorption_refused',
    subject,
    'A site is confirmed; the document now absorbs.',
    now,
  );

  return {
    versionId: version.id,
    outcome: 'absorbed',
    rowsWritten: records.length,
    datesCovered: daily.rows.length,
    reason: null,
    anomaliesRaised: 0,
  };
}

export interface AbsorptionPassResult {
  versionsConsidered: number;
  absorbed: number;
  refused: number;
  empty: number;
  unreadable: number;
  notAbsorbable: number;
  rowsWritten: number;
  anomaliesRaised: number;
}

export interface AbsorptionPassOptions extends AbsorbDeps {
  /** Bound the work one pass will do. */
  limit?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * The absorption queue: applied revisions of enabled sources that have not reached
 * a terminal absorption outcome.
 *
 * Ordered oldest-applied-first so a backlog drains in the order it arrived, and
 * bounded per pass so one enormous backlog cannot stall the sweep that calls it.
 *
 * The `absorbed_at IS NULL` predicate is what makes this self-backfilling: every
 * revision applied before this bridge existed is already in the queue.
 */
export async function runAbsorptionPass(
  prisma: PrismaClient,
  options: AbsorptionPassOptions = {},
): Promise<AbsorptionPassResult> {
  const limit = options.limit ?? 25;
  const log = options.log ?? ((): void => undefined);
  const result: AbsorptionPassResult = {
    versionsConsidered: 0,
    absorbed: 0,
    refused: 0,
    empty: 0,
    unreadable: 0,
    notAbsorbable: 0,
    rowsWritten: 0,
    anomaliesRaised: 0,
  };

  // Two flat reads rather than one relation-filtered join. The sources are few
  // (three, live) and both queries hit an index — and a flat read is the shape a
  // test can exercise honestly, which matters more here than a join: the sweep
  // calls this inside a try/catch, so a query this pass could not actually run
  // would be swallowed as a warning and look like "nothing to absorb".
  const sources = await prisma.docSource.findMany({
    where: { enabled: true, doc_class: { in: [...ABSORBABLE_KINDS] } },
  });
  if (sources.length === 0) return result;
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const versions = await prisma.docSourceVersion.findMany({
    where: {
      applied_at: { not: null },
      absorbed_at: null,
      doc_source_id: { in: [...sourceById.keys()] },
    },
    orderBy: { applied_at: 'asc' },
    take: limit,
  });

  for (const version of versions) {
    const source = sourceById.get(version.doc_source_id);
    if (!source) continue;
    result.versionsConsidered += 1;
    const one = await absorbVersion(prisma, source, version, options);
    result.rowsWritten += one.rowsWritten;
    result.anomaliesRaised += one.anomaliesRaised;
    switch (one.outcome) {
      case 'absorbed':
        result.absorbed += 1;
        break;
      case 'refused_unclassified_site':
        result.refused += 1;
        break;
      case 'empty':
        result.empty += 1;
        break;
      case 'unreadable':
        result.unreadable += 1;
        break;
      case 'not_absorbable':
        result.notAbsorbable += 1;
        break;
    }
    log(
      one.outcome === 'absorbed' ? 'info' : 'warn',
      `[doc-ingest:absorb] version=${version.id} source="${source.display_name}" ` +
        `outcome=${one.outcome} rows=${one.rowsWritten}${one.reason ? ` — ${one.reason}` : ''}`,
    );
  }

  return result;
}

/** Record a TERMINAL outcome (latches `absorbed_at`; will not re-attempt). */
async function finishTerminal(
  prisma: PrismaClient,
  version: DocSourceVersion,
  result: AbsorbResult,
  now: Date,
): Promise<AbsorbResult> {
  await prisma.docSourceVersion.update({
    where: { id: version.id },
    data: {
      absorbed_at: now,
      absorption_status: result.outcome,
      absorption_rows: result.rowsWritten,
      absorption_error: result.reason,
    },
  });
  return result;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
