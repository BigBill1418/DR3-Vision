// ADR-0039 D4 — the Summary-recompute check (reproduces the §4.1 sum-range
// drift audit). Recompute every Summary figure from the workbook's OWN detail
// rows and flag rows the template's SUM range dropped — the "fuel rows 71–130"
// class where money already silently fell out of the workbook.
//
// Also resolves workbook site names through the alias interface; an unresolvable
// name emits an `unresolved_site` finding (never a silently dropped row).

import { makeFinder } from '../comparators/helpers';
import type { AuditWindow, CheckConfig, Finding, SiteAliasResolver } from '../types';
import type { InboundStage, ParsedWorkbook } from './parser';

/**
 * Recompute Summary figures from detail rows. A figure whose stored total differs
 * from the full detail sum produces a finding; when the gap is explained by rows
 * OUTSIDE the template's summed range, the kind is `dropped_row` and the dropped
 * cells are itemized in the finding detail (evidence, with provenance).
 */
export function recomputeSummary(
  window: AuditWindow,
  parsed: ParsedWorkbook,
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('summary_recompute', window, config);
  const out: Finding[] = [];

  for (const fig of parsed.summaryFigures) {
    const amounts = parsed.detailAmountsByFigure.get(fig.key);
    if (!amounts || amounts.length === 0) continue; // no detail block to recompute against

    const fullSum = amounts.reduce((s, a) => s + a.value, 0);
    const delta = fullSum - fig.storedValue;
    if (Math.abs(delta) <= config.unitTolerance) continue;

    const dropped = amounts.filter((a) => a.outsideRange);
    const droppedSum = dropped.reduce((s, a) => s + a.value, 0);
    const kind = dropped.length > 0 ? 'dropped_row' : 'value_mismatch';

    out.push(
      finding({
        kind,
        keys: [fig.key],
        legARef: `${fig.provenance.tab}!${fig.provenance.col}${fig.provenance.row}`,
        legBRef: fig.detailSheet ? `${fig.detailSheet}!${fig.detailColumn}` : null,
        expected: { recomputed: fullSum },
        actual: { storedValue: fig.storedValue },
        detail: {
          figure: fig.key,
          delta,
          droppedRowCount: dropped.length,
          droppedSum,
          templateRange:
            fig.rangeFirstRow !== null ? `${fig.detailColumn}${fig.rangeFirstRow}:${fig.detailColumn}${fig.rangeLastRow}` : null,
          droppedRows: dropped.map((a) => ({ row: a.row, col: a.column, value: a.value })),
          note:
            dropped.length > 0
              ? 'Summary SUM range clipped detail rows — money already dropped'
              : 'Summary stored total does not match recomputed detail sum',
        },
      }),
    );
  }

  return out;
}

/**
 * Resolve each staged inbound site name through the alias resolver. An
 * unresolvable name surfaces as its own `unresolved_site` finding rather than
 * silently dropping the row (ADR-0039 D4).
 */
export function resolveInboundSites(
  window: AuditWindow,
  inbound: readonly InboundStage[],
  resolver: SiteAliasResolver,
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('summary_recompute', window, config);
  const out: Finding[] = [];
  const seen = new Set<string>();

  for (const row of inbound) {
    const resolved = resolver.resolve(row.siteNameRaw);
    if (resolved) continue;
    const key = row.siteNameRaw.trim().toLowerCase();
    if (seen.has(key)) continue; // one finding per distinct unresolved name
    seen.add(key);
    out.push(
      finding({
        kind: 'unresolved_site',
        keys: ['unresolved_site', key],
        legARef: `${row.provenance.tab}!${row.provenance.row}`,
        legBRef: null,
        expected: null,
        actual: { siteNameRaw: row.siteNameRaw },
        detail: {
          note: 'workbook site name did not resolve to a known site',
          provenance: { tab: row.provenance.tab, row: row.provenance.row, col: row.provenance.col },
        },
        severity: 'medium',
      }),
    );
  }

  return out;
}
