// C6 — Inventory continuity (internal invariant). Equation is Addendum B §B4
// verbatim: `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`.
// The non-program ledger is checked separately; `Saved` is excluded (B10-2).
//
// Three named exhibit classes this reproduces:
//   - continuity break: recorded End ≠ computed End for a day.
//   - roll break: a day's recorded Start ≠ the prior day's recorded End — the
//     "Friday doesn't carry to Monday" class (Janette Q11) AND the DAY6
//     hardcoded-2863 roll (Addendum B §B4).
//   - physical reconcile: |physical snapshot − computed End| beyond tolerance.

import type { AuditWindow, CheckConfig, Finding, InventoryDayRow } from '../types';
import { makeFinder } from './helpers';

function computedEnd(r: InventoryDayRow): number | null {
  if (r.recordedStart === null) return null;
  return r.recordedStart + r.inbound - r.stripped - r.wholeUnitsSold - r.landfilled;
}

function computedNpEnd(r: InventoryDayRow): number | null {
  if (r.npRecordedStart === null) return null;
  return r.npRecordedStart + r.npInbound - (r.npStripped ?? 0) - r.npSold - r.npLandfilled;
}

export function c6InventoryContinuity(
  window: AuditWindow,
  days: readonly InventoryDayRow[],
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('c6_inventory_continuity', window, config);
  const out: Finding[] = [];

  const sorted = [...days].sort((a, b) => a.dateISO.localeCompare(b.dateISO));

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;

    // Continuity: recorded End vs computed End.
    const cEnd = computedEnd(r);
    if (cEnd !== null && r.recordedEnd !== null && Math.abs(cEnd - r.recordedEnd) > config.unitTolerance) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [r.dateISO, 'continuity'],
          legARef: r.dateISO,
          legBRef: null,
          expected: { computedEnd: cEnd },
          actual: { recordedEnd: r.recordedEnd },
          detail: {
            equation: 'End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled',
            start: r.recordedStart,
            inbound: r.inbound,
            stripped: r.stripped,
            wholeUnitsSold: r.wholeUnitsSold,
            landfilled: r.landfilled,
          },
        }),
      );
    }

    // NP continuity (separate ledger).
    const cNp = computedNpEnd(r);
    if (cNp !== null && r.npRecordedEnd !== null && Math.abs(cNp - r.npRecordedEnd) > config.unitTolerance) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [r.dateISO, 'np_continuity'],
          legARef: r.dateISO,
          legBRef: null,
          expected: { computedNpEnd: cNp },
          actual: { recordedNpEnd: r.npRecordedEnd },
          detail: { ledger: 'non_program' },
        }),
      );
    }

    // Roll break: this day's recorded Start must equal the prior day's recorded End.
    const prev = i > 0 ? sorted[i - 1]! : null;
    if (prev && prev.recordedEnd !== null && r.recordedStart !== null && r.recordedStart !== prev.recordedEnd) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [r.dateISO, 'roll_break'],
          legARef: r.dateISO,
          legBRef: prev.dateISO,
          expected: { start: prev.recordedEnd },
          actual: { start: r.recordedStart },
          detail: {
            note: 'day start does not carry from prior day end (Friday→Monday / DAY6 hardcoded-roll class)',
            priorDay: prev.dateISO,
            priorEnd: prev.recordedEnd,
          },
        }),
      );
    }

    // Physical reconciliation delta against the computed balance.
    if (r.physicalSnapshot !== null && cEnd !== null && Math.abs(r.physicalSnapshot - cEnd) > config.unitTolerance) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [r.dateISO, 'physical_reconcile'],
          legARef: r.dateISO,
          legBRef: null,
          expected: { computedEnd: cEnd },
          actual: { physicalSnapshot: r.physicalSnapshot },
          detail: { delta: r.physicalSnapshot - cEnd, note: 'physical count vs computed balance' },
        }),
      );
    }
  }

  return out;
}
