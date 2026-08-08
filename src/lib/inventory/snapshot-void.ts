// ADR-0084 — the void filter, in ONE place, because omitting it is silent.
//
// A `physical` row in `site_inventory_snapshots` is the ANCHOR. `onHand()` picks
// the latest one and every downstream floor, COR, EOD and MRC billing number is
// computed FORWARD from it. So a reader that forgets `voided_at: null` does not
// return a slightly wrong list — it anchors the entire floor on a count a human
// has explicitly said was a mistake, and nothing anywhere reports that it did.
//
// ## Why a constant rather than a convention
//
// The audit that preceded this ADR found THIRTEEN non-test read sites on this
// table, spread across five directories, written by different passes over eight
// months. "Remember to add `voided_at: null`" is a sentence in a document; the
// next reader is written by someone who never read the document. Three things
// make omission structurally hard instead:
//
//   1. This module. Nobody writes the predicate inline, so grepping for the
//      import finds every participant.
//   2. `snapshot-void-readers.guard.test.ts`, which parses the ACTUAL source of
//      every `siteInventorySnapshot` read in `src/` and fails the build naming
//      any call site whose where-clause does not carry `NOT_VOIDED`. It also
//      asserts how many call sites it inspected, so a scan that silently matches
//      nothing fails loudly rather than reporting green.
//   3. An explicit, commented allowlist inside that test for the deliberate
//      exceptions — the surfaces that MUST still show voided rows.
//
// The exceptions matter as much as the rule. `/admin/inventory/anchors` is the
// recovery surface: hiding a voided count there would reproduce the exact
// problem soft-voiding exists to avoid (a number vanishes and the history stops
// explaining what happened). Same for the manager snapshot list, which is a
// history, not an anchor selector. Those two SHOW voided rows and label them.

import type { Prisma } from '@prisma/client';

/**
 * The live-snapshot predicate. Spread into every `siteInventorySnapshot`
 * where-clause that selects an anchor or counts real activity:
 *
 * ```ts
 * where: { ...NOT_VOIDED, site_id: siteId, snapshot_kind: 'physical' }
 * ```
 *
 * A nullable timestamp rather than a boolean, so the row and its audit entry can
 * never disagree about WHEN — see the migration header for that reasoning.
 */
export const NOT_VOIDED = { voided_at: null } as const;

/**
 * Compose {@link NOT_VOIDED} onto a where-clause that is BUILT rather than
 * written as a literal (the workbook-promotion conflict scan constructs its
 * bounds from arguments). Identical semantics to spreading the constant; it
 * exists so a computed where-clause still has one obvious, greppable way to
 * carry the filter instead of an inline `voided_at: null` the guard would have
 * to special-case.
 */
export function notVoidedSnapshotWhere<T extends Prisma.SiteInventorySnapshotWhereInput>(
  where: T,
): T & { voided_at: null } {
  return { ...where, ...NOT_VOIDED };
}

/**
 * Runtime predicate for a row already in hand.
 *
 * Needed because `findUnique` takes only unique fields in its where-clause, so
 * `/api/admin/inventory/anchors/reactivate` cannot filter at the query — it
 * fetches by id and must REFUSE afterwards. Also drives the struck-through
 * rendering on the surfaces that deliberately still show voided counts.
 */
export function isVoidedSnapshot(row: { voided_at: Date | null }): boolean {
  return row.voided_at !== null;
}
