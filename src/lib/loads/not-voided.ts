// ADR-0090 C — "this load was disowned", said once, where a query can reach it.
//
// Adding `voided` to `LoadStatus` is safe for every reader that filters through
// a status ALLOW-list (INVOICE_STATUSES, VERIFIED_INBOUND_STATUSES,
// OPEN_DOCK_STATUSES, TAKEOVER_STATUSES, VERIFIABLE_FROM) — a new member is
// excluded from all of them by construction, which is the whole reason the void
// is an enum member and not a nullable column.
//
// It is NOT safe for the readers that are status-BLIND: they filter on
// `site_id` + a date window and take whatever `inbound_loads` rows fall in it.
// Those were audited one by one on 2026-08-10 and the ones a floor-voided
// `b2b_haul` load can actually reach are patched with this helper:
//
//   - `compliance.ts` metric 1 (MyMRC submission timeliness) — a voided load
//     past its deadline would count as `late` forever, degrading a contractual
//     compliance grade with a truck that never came.
//   - `compliance.ts` metric 3 (dock SLA) — a voided load with a slow unload
//     would drag the SLA percentage permanently.
//   - `compliance.ts` metric 7 (records retention) — a voided row would set the
//     retention countdown from an event that did not happen.
//   - `ops-overview.ts` `loadsArrivedToday` — a mis-tap would inflate the
//     arrival count a manager reads as "trucks that came today".
//   - `workbook-promotion.ts` live-row conflict scan — a voided load would wedge
//     a workbook import against a conflict that is not one.
//
// Deliberately `status: { not: 'voided' }` rather than `voided_at: null`. The
// status is what every other reader on this model keys on, and having ONE
// question ("is this load voided?") answered two different ways across the
// codebase is how the two answers eventually disagree.
//
// Sites NOT patched, and why (checked, not assumed): the `floor-inbound.ts`,
// `bulk-inbound.ts` and `inbound-bridge.ts` precedence lookups are status-blind
// but scoped to `load_source_type in AGGREGATE_SOURCE_TYPES` / `mymrc_haul` /
// `paper_bulk`. A dock load started from a queue tap is `b2b_haul` (the model
// default), so the floor void cannot produce a row those queries can see. If a
// void is ever offered on an aggregate row, they become reachable — hence this
// note rather than silence.

import type { Prisma } from '@prisma/client';

/** The predicate itself, for spreading into a `where` that is built inline. */
export const NOT_VOIDED_LOAD = {
  status: { not: 'voided' },
} as const satisfies Prisma.InboundLoadWhereInput;

/**
 * Exclude voided loads from a status-blind `where`.
 *
 * Mirrors `notVoidedSnapshotWhere` in `src/lib/inventory/snapshot-void.ts` so a
 * reader who has met one recognises the other.
 */
export function notVoidedLoadWhere<T extends Prisma.InboundLoadWhereInput>(
  where: T,
): T & typeof NOT_VOIDED_LOAD {
  return { ...where, ...NOT_VOIDED_LOAD };
}
