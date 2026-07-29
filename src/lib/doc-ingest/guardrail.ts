// ADR-0067 §3.2 D6/D7 — the auto-flow guardrail.
//
// ── The shape of the decision ───────────────────────────────────────────────
// D6: after a document's classification is confirmed, changes propagate
// AUTOMATICALLY. Per-change approval would defeat the entire feature — the point
// is that Bill stops touching these documents.
//
// D7: so the approval gate is replaced by a GUARDRAIL. It does not gate normal
// changes; it catches ABNORMAL ones. Four conditions stage-and-page:
//
//   1. a billing/inventory aggregate moves beyond the variance threshold
//   2. a previously-populated column is emptied or nulled
//   3. more than a configured share of rows disappear
//   4. the document no longer parses as its registered classification
//
// Anything else flows, and every auto-applied change writes a full before/after
// audit_log entry.
//
// ── One variance concept, not two ───────────────────────────────────────────
// Condition 1 calls `evaluateVariance` from ADR-0046 Amendment 5 (D-M5-4) — the
// SAME pure either-trips function, the SAME $50-flat / 15-percent constants that
// the AP approver panel enforces. Reimplementing the arithmetic here would give
// the system two definitions of "abnormal", and the first time somebody tuned
// one of them nobody would know which one applied to what.

import { evaluateVariance, type EstablishedBaseline } from '@/lib/ap/variance';
import {
  docIngestRowDropThreshold,
  VARIANCE_FLAT_THRESHOLD_CENTS,
  VARIANCE_PERCENT_THRESHOLD,
} from './pipeline-config';
import type { ParseSummary, SheetSummary } from './parse';
import type { DocIngestAnomalyKind } from '@prisma/client';

export interface GuardrailFinding {
  kind: Extract<
    DocIngestAnomalyKind,
    'aggregate_variance' | 'column_nulled' | 'row_count_drop' | 'parse_broken'
  >;
  /** Operator-facing sentence. Names the figure, both values, and the threshold. */
  detail: string;
  /** Machine-readable before/after for the anomalies page diff. */
  context: Record<string, unknown>;
}

export interface GuardrailVerdict {
  /** True ⇒ hold the revision for apply-or-discard instead of auto-applying. */
  stage: boolean;
  findings: GuardrailFinding[];
}

const CLEAN: GuardrailVerdict = { stage: false, findings: [] };

/**
 * Which columns count as a "billing/inventory aggregate".
 *
 * Deliberately a NAME test rather than "any numeric column". A workbook is full
 * of numeric columns that are not aggregates — row numbers, years, ticket ids,
 * percentages — and treating those as money produces variance alarms that are
 * pure noise. Under ADR-0037 a guardrail that cries wolf is worse than no
 * guardrail, because Bill learns to click through it.
 */
const AGGREGATE_COLUMN =
  /(amount|total|cost|price|charge|rate|fee|revenue|paid|due|balance|units?|count|qty|quantity|weight|lbs?|pounds|tons?)/i;

export function isAggregateColumn(header: string): boolean {
  return AGGREGATE_COLUMN.test(header);
}

export interface EvaluateGuardrailArgs {
  previous: ParseSummary | null;
  next: ParseSummary;
  /** The CONFIRMED classification, or null when the source is still unconfirmed. */
  registeredKind: string | null;
  /** Whether the new revision parsed at all. False ⇒ condition 4. */
  parsed: boolean;
  parseError?: string | null;
  rowDropThreshold?: number;
}

/**
 * Compare two revisions and decide whether the change is normal.
 *
 * A source with NO previous revision always auto-applies: there is nothing to be
 * abnormal relative to, and staging every first ingest would put a manual step
 * back in front of exactly the documents the feature exists to automate.
 */
export function evaluateGuardrail(args: EvaluateGuardrailArgs): GuardrailVerdict {
  const findings: GuardrailFinding[] = [];
  const rowDropThreshold = args.rowDropThreshold ?? docIngestRowDropThreshold();

  // ── Condition 4 — the registered classification no longer parses ──────────
  // Checked first: if the document cannot be read, the other three comparisons
  // would be comparing against nothing and would each report a spurious collapse.
  if (!args.parsed) {
    findings.push({
      kind: 'parse_broken',
      detail: args.registeredKind
        ? `This document is registered as "${args.registeredKind}" but the new revision no longer parses as one: ` +
          `${args.parseError ?? 'unreadable'}. Its structure has changed materially — the numbers behind it are frozen ` +
          `at the previous revision until someone confirms what it is now.`
        : `The new revision could not be parsed: ${args.parseError ?? 'unreadable'}.`,
      context: { registeredKind: args.registeredKind, parseError: args.parseError ?? null },
    });
    return { stage: true, findings };
  }

  if (!args.previous) return CLEAN;

  const previousSheets = indexSheets(args.previous);
  const nextSheets = indexSheets(args.next);

  // ── Condition 3 — row loss ───────────────────────────────────────────────
  // Measured on the WHOLE document, not per sheet: a monthly workbook that gains
  // a sheet and loses another has not lost data, and per-sheet accounting would
  // stage that perfectly ordinary change every month.
  if (args.previous.totalRows > 0) {
    const dropped = args.previous.totalRows - args.next.totalRows;
    const share = dropped / args.previous.totalRows;
    if (dropped > 0 && share > rowDropThreshold) {
      findings.push({
        kind: 'row_count_drop',
        detail:
          `The new revision has ${args.next.totalRows} rows, down from ${args.previous.totalRows} — ` +
          `${dropped} rows (${(share * 100).toFixed(1)}%) are gone, past the ` +
          `${(rowDropThreshold * 100).toFixed(0)}% threshold.`,
        context: {
          previousRows: args.previous.totalRows,
          nextRows: args.next.totalRows,
          droppedRows: dropped,
          droppedShare: share,
          threshold: rowDropThreshold,
        },
      });
    }
  }

  for (const [sheetName, previousSheet] of previousSheets) {
    const nextSheet = nextSheets.get(sheetName);
    // A vanished sheet is caught by the whole-document row check above; treating
    // it separately here would double-report the same event.
    if (!nextSheet) continue;

    // ── Condition 2 — a populated column went empty ────────────────────────
    for (const column of previousSheet.populatedColumns) {
      if (nextSheet.populatedColumns.includes(column)) continue;
      const removed = !nextSheet.headers.includes(column);
      findings.push({
        kind: 'column_nulled',
        detail: removed
          ? `Column "${column}" on sheet "${sheetName}" has been REMOVED. It held data in the previous revision.`
          : `Column "${column}" on sheet "${sheetName}" is now completely empty. It held data in the previous revision.`,
        context: { sheet: sheetName, column, removed },
      });
    }

    // ── Condition 1 — an aggregate moved too far ──────────────────────────
    for (const [column, nextTotal] of Object.entries(nextSheet.numericTotals)) {
      if (!isAggregateColumn(column)) continue;
      const previousTotal = previousSheet.numericTotals[column];
      if (previousTotal === undefined) continue;

      const evaluation = evaluateVariance(baselineFor(column, previousTotal), toCents(nextTotal));
      if (!evaluation.tripped) continue;

      findings.push({
        kind: 'aggregate_variance',
        detail:
          `"${column}" on sheet "${sheetName}" moved ${evaluation.direction} from ` +
          `${formatFigure(previousTotal)} to ${formatFigure(nextTotal)} — a change of ` +
          `${formatFigure(Math.abs(nextTotal - previousTotal))} (${(evaluation.variancePct * 100).toFixed(1)}%), ` +
          `past the $${(VARIANCE_FLAT_THRESHOLD_CENTS / 100).toFixed(2)} / ` +
          `${(VARIANCE_PERCENT_THRESHOLD * 100).toFixed(0)}% threshold.`,
        context: {
          sheet: sheetName,
          column,
          previousTotal,
          nextTotal,
          delta: nextTotal - previousTotal,
          variancePct: evaluation.variancePct,
          direction: evaluation.direction,
          flatThresholdCents: evaluation.flatThresholdCents,
          percentThreshold: evaluation.percentThreshold,
        },
      });
    }
  }

  return { stage: findings.length > 0, findings };
}

/**
 * Wrap a previous total as an `EstablishedBaseline` so the AP variance evaluator
 * can score it unchanged.
 *
 * `invoiceCount: 1` is honest — one prior observation. It is not used by
 * `evaluateVariance` (only by the AP-side "is this baseline established yet"
 * gate, which does not apply to a document revision: the previous revision IS
 * the baseline, by definition, and waiting for three of them would leave the
 * first two changes unguarded).
 */
function baselineFor(column: string, previousTotal: number): EstablishedBaseline {
  return {
    vendorDisplayName: column,
    invoiceCount: 1,
    meanAmountCents: toCents(previousTotal),
    flatThresholdCents: VARIANCE_FLAT_THRESHOLD_CENTS,
    percentThreshold: VARIANCE_PERCENT_THRESHOLD,
  };
}

/**
 * Scale a figure into the integer-cents space the AP evaluator works in.
 *
 * This is a UNIT bridge, not a claim that every column is money. A count column
 * of 1,200 units becomes 120,000 "cents", so the $50 flat threshold reads as
 * "50 units" for that column — a sane absolute floor that stops the 15% rule
 * from firing on tiny counts, which is exactly what the flat threshold does for
 * money too. Documented because the alternative reading (that unit counts are
 * being treated as dollars) would be a bug.
 */
function toCents(value: number): number {
  return Math.round(value * 100);
}

function formatFigure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function indexSheets(summary: ParseSummary): Map<string, SheetSummary> {
  return new Map(summary.sheets.map((s) => [s.name, s]));
}
