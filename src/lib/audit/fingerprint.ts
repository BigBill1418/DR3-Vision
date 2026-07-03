// ADR-0039 D2 — stable finding fingerprints.
//
// A fingerprint is `check_code + kind + the semantic keys the comparator chooses`
// (the "window semantics" clause of D2). Record-level checks (C1/C3/C7) key on
// the record identity so the SAME discrepancy dedupes across overlapping sweep
// windows and retro runs; window-level checks (C4/C5/C6) key on the day/period.
//
// The result is a readable, greppable TEXT value (the column is unbounded) —
// deterministic and case/whitespace-normalized so trivial input drift can never
// spawn a duplicate finding.

import type { CheckCode, FindingKind } from './types';

/** Lower-case, trim, collapse internal whitespace; `null`/'' → the literal `∅`. */
export function normalizeKey(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '∅';
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build a stable fingerprint. `keys` are the comparator-chosen semantic
 * identifiers (e.g. a haul id, or a day key). Order matters and is preserved.
 */
export function makeFingerprint(
  checkCode: CheckCode,
  kind: FindingKind,
  keys: readonly (string | number | null | undefined)[],
): string {
  return [checkCode, kind, ...keys.map(normalizeKey)].join('|');
}
