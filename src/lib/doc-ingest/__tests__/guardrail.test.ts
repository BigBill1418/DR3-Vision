// ADR-0067 §3.2 D7 — the auto-flow guardrail.
//
// The four staging conditions, the thresholds, and — just as important — the
// cases that must NOT stage. A guardrail that fires on ordinary change is worse
// than no guardrail (ADR-0037): the operator learns to click through it.

import { describe, expect, it } from 'vitest';
import { evaluateGuardrail, isAggregateColumn } from '../guardrail';
import { VARIANCE_FLAT_THRESHOLD_CENTS, VARIANCE_PERCENT_THRESHOLD } from '@/lib/ap/variance';
import type { ParseSummary } from '../parse';

function summary(rows: number, totals: Record<string, number>, populated?: string[]): ParseSummary {
  const headers = Object.keys(totals);
  return {
    format: 'xlsx',
    sheets: [
      {
        name: 'Sheet1',
        rowCount: rows,
        headers,
        populatedColumns: populated ?? headers,
        numericTotals: totals,
      },
    ],
    totalRows: rows,
    textSample: '',
  };
}

describe('doc-ingest guardrail (D7)', () => {
  it('uses the SAME thresholds as ADR-0046 Amendment 5 — one anomaly concept, not two', () => {
    // Guards against the drift the directive explicitly warned about: if these
    // ever diverge, the system holds two definitions of "abnormal".
    expect(VARIANCE_FLAT_THRESHOLD_CENTS).toBe(5000);
    expect(VARIANCE_PERCENT_THRESHOLD).toBe(0.15);
  });

  it('auto-applies a first revision — there is nothing to be abnormal against', () => {
    const verdict = evaluateGuardrail({
      previous: null,
      next: summary(100, { Amount: 1000 }),
      registeredKind: 'daily_log_workbook',
      parsed: true,
    });
    expect(verdict.stage).toBe(false);
    expect(verdict.findings).toHaveLength(0);
  });

  it('auto-applies an ordinary change — the guardrail must not gate normal work', () => {
    const verdict = evaluateGuardrail({
      previous: summary(100, { Amount: 1000 }),
      // +$10 on $1000: under the $50 flat AND under 15%.
      next: summary(102, { Amount: 1010 }),
      registeredKind: 'daily_log_workbook',
      parsed: true,
    });
    expect(verdict.stage).toBe(false);
  });

  describe('condition 1 — aggregate variance', () => {
    it('stages when the FLAT $50 threshold trips even though the percentage is tiny', () => {
      const verdict = evaluateGuardrail({
        previous: summary(100, { Amount: 100_000 }),
        next: summary(100, { Amount: 100_060 }), // +$60 = 0.06%
        registeredKind: 'daily_log_workbook',
        parsed: true,
      });
      expect(verdict.stage).toBe(true);
      expect(verdict.findings[0]?.kind).toBe('aggregate_variance');
      expect(verdict.findings[0]?.detail).toContain('Amount');
    });

    it('stages when the 15% threshold trips even though the flat delta is small', () => {
      const verdict = evaluateGuardrail({
        previous: summary(10, { Units: 100 }),
        next: summary(10, { Units: 130 }), // +30%, but only 30 "units"
        registeredKind: 'daily_log_workbook',
        parsed: true,
      });
      expect(verdict.stage).toBe(true);
      expect(verdict.findings[0]?.kind).toBe('aggregate_variance');
    });

    it('reports the direction and both values so the operator can judge it', () => {
      const verdict = evaluateGuardrail({
        previous: summary(100, { Total: 5000 }),
        next: summary(100, { Total: 1000 }),
        registeredKind: 'ap_history_report',
        parsed: true,
      });
      const finding = verdict.findings[0];
      expect(finding?.context['direction']).toBe('under');
      expect(finding?.context['previousTotal']).toBe(5000);
      expect(finding?.context['nextTotal']).toBe(1000);
    });

    it('ignores NON-aggregate columns — a year or a row id moving is not a variance', () => {
      expect(isAggregateColumn('Year')).toBe(false);
      expect(isAggregateColumn('Ticket ID')).toBe(false);
      expect(isAggregateColumn('Amount')).toBe(true);
      expect(isAggregateColumn('Total Weight (lbs)')).toBe(true);

      const verdict = evaluateGuardrail({
        previous: summary(3, { Year: 6078 }),
        next: summary(3, { Year: 12_156 }), // doubled, and utterly meaningless
        registeredKind: 'rate_table',
        parsed: true,
      });
      expect(verdict.stage).toBe(false);
    });

    it('does not compare a column that did not exist before', () => {
      const verdict = evaluateGuardrail({
        previous: summary(10, { Amount: 100 }),
        next: summary(10, { Amount: 100, 'New Total': 999_999 }),
        registeredKind: 'daily_log_workbook',
        parsed: true,
      });
      expect(verdict.stage).toBe(false);
    });
  });

  describe('condition 2 — a populated column emptied', () => {
    it('stages when a previously-populated column goes empty', () => {
      const verdict = evaluateGuardrail({
        previous: summary(10, { Amount: 100, Vendor: 0 }, ['Amount', 'Vendor']),
        next: summary(10, { Amount: 100, Vendor: 0 }, ['Amount']),
        registeredKind: 'ap_history_report',
        parsed: true,
      });
      expect(verdict.stage).toBe(true);
      const finding = verdict.findings.find((f) => f.kind === 'column_nulled');
      expect(finding?.context['column']).toBe('Vendor');
      expect(finding?.context['removed']).toBe(false);
    });

    it('distinguishes a REMOVED column from one that is merely empty', () => {
      const previous: ParseSummary = summary(10, { Amount: 100, Vendor: 0 }, ['Amount', 'Vendor']);
      const next: ParseSummary = {
        ...summary(10, { Amount: 100 }, ['Amount']),
        sheets: [
          {
            name: 'Sheet1',
            rowCount: 10,
            headers: ['Amount'],
            populatedColumns: ['Amount'],
            numericTotals: { Amount: 100 },
          },
        ],
      };
      const verdict = evaluateGuardrail({
        previous,
        next,
        registeredKind: 'ap_history_report',
        parsed: true,
      });
      expect(verdict.findings.find((f) => f.kind === 'column_nulled')?.context['removed']).toBe(
        true,
      );
    });
  });

  describe('condition 3 — row loss', () => {
    it('stages past the 10% default', () => {
      const verdict = evaluateGuardrail({
        previous: summary(100, {}),
        next: summary(85, {}),
        registeredKind: 'daily_log_workbook',
        parsed: true,
      });
      expect(verdict.stage).toBe(true);
      expect(verdict.findings[0]?.kind).toBe('row_count_drop');
      expect(verdict.findings[0]?.context['droppedRows']).toBe(15);
    });

    it('does not stage at or under the threshold', () => {
      const verdict = evaluateGuardrail({
        previous: summary(100, {}),
        next: summary(90, {}), // exactly 10% — not PAST the threshold
        registeredKind: 'daily_log_workbook',
        parsed: true,
      });
      expect(verdict.stage).toBe(false);
    });

    it('never stages on GROWTH — a workbook gaining rows is the normal case', () => {
      const verdict = evaluateGuardrail({
        previous: summary(100, {}),
        next: summary(5000, {}),
        registeredKind: 'daily_log_workbook',
        parsed: true,
      });
      expect(verdict.stage).toBe(false);
    });

    it('honours a configured threshold', () => {
      const verdict = evaluateGuardrail({
        previous: summary(100, {}),
        next: summary(98, {}),
        registeredKind: 'daily_log_workbook',
        parsed: true,
        rowDropThreshold: 0,
      });
      expect(verdict.stage).toBe(true);
    });
  });

  describe('condition 4 — the registered classification no longer parses', () => {
    it('stages and names the registered kind', () => {
      const verdict = evaluateGuardrail({
        previous: summary(100, { Amount: 100 }),
        next: summary(0, {}),
        registeredKind: 'daily_log_workbook',
        parsed: false,
        parseError: 'not a valid Office Open XML package',
      });
      expect(verdict.stage).toBe(true);
      expect(verdict.findings).toHaveLength(1);
      expect(verdict.findings[0]?.kind).toBe('parse_broken');
      expect(verdict.findings[0]?.detail).toContain('daily_log_workbook');
    });

    it('short-circuits the other checks so one break is not reported four times', () => {
      const verdict = evaluateGuardrail({
        previous: summary(1000, { Amount: 999_999 }, ['Amount']),
        next: summary(0, {}),
        registeredKind: 'daily_log_workbook',
        parsed: false,
        parseError: 'unreadable',
      });
      // Without the short-circuit this would ALSO report a row drop and an
      // aggregate collapse — three pages for one event.
      expect(verdict.findings.map((f) => f.kind)).toEqual(['parse_broken']);
    });
  });

  it('reports every independent finding at once rather than stopping at the first', () => {
    const verdict = evaluateGuardrail({
      previous: summary(100, { Amount: 100_000, Vendor: 0 }, ['Amount', 'Vendor']),
      next: summary(50, { Amount: 200_000, Vendor: 0 }, ['Amount']),
      registeredKind: 'ap_history_report',
      parsed: true,
    });
    const kinds = verdict.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['aggregate_variance', 'column_nulled', 'row_count_drop']);
  });
});
