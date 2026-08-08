// ADR-0037 amendment (rollup 2026-07-17 §3.2 + §A.5) — inbound → inventory-pool routing.
//
// Program-ness is a property of the collection SITE / channel, not the commodity. The
// inventory ledger (running-balance.ts) has exactly TWO pools — program and non-program —
// because MRC is billed on PROGRAM units only. This module is the single source of truth
// for which pool a given inbound channel contributes to.
//
// Rick (§3.2): "illegals are treated the same as unpaid" → both feed the PROGRAM pool.
// Kelsey (§A.5): event units "get added to the running inventory the same way as standard
// inbounds" → events also feed the PROGRAM pool for INVENTORY. Event BILLING is a separate
// structure (Event Mile Rate tier §3.7 + labor) tracked off this ledger — the `event`
// channel is retained so a caller can split billing without changing inventory.
//
// §3.2 routing: mrc_program + collection + unpaid_dropoff + illegal_dropoff (+ incentive
// drop-offs, the CIP paid channel) → PROGRAM pool; non_program → NON-PROGRAM pool; events
// feed the program pool for inventory but bill separately.

import type { ConsumerDropoffKind, LoadSourceType } from '@prisma/client';

/** The two inventory pools MRC billing distinguishes. */
export type InventoryPool = 'program' | 'non_program';

/**
 * The canonical inbound channel — spans `InboundLoad.load_source_type` and
 * `ConsumerDropoff.kind` (rollup §3.2's conceptual load-source-kind list). Note there is
 * NO separate `illegal_dropoff` enum value on the schema: `ConsumerDropoffKind.illegal`
 * already carries that concept, so this channel maps onto the EXISTING enum rather than
 * duplicating it.
 */
export type InboundChannel =
  | 'mrc_program' // b2b program haul (LoadSourceType.b2b_haul, program source)
  | 'non_program' // non-program haul (is_non_program source)
  | 'collection' // collection-site haul (SVDP sites)
  | 'incentive_dropoff' // ConsumerDropoffKind.incentive (CIP paid)
  | 'unpaid_dropoff' // ConsumerDropoffKind.unpaid
  | 'illegal_dropoff' // ConsumerDropoffKind.illegal
  | 'floor_dropoff' // ADR-0085 — ConsumerDropoffKind.floor_public | floor_incentive
  | 'event'; // LoadSourceType.event

/**
 * Route an inbound channel to its INVENTORY pool. Everything except an explicitly
 * non-program haul feeds the program pool (drop-offs, collection, and — per §A.5 —
 * events). Event billing is handled separately; this is inventory only.
 */
export function routeInboundToInventoryPool(channel: InboundChannel): InventoryPool {
  return channel === 'non_program' ? 'non_program' : 'program';
}

/** Map a `ConsumerDropoff.kind` onto the canonical channel. */
export function dropoffKindToChannel(kind: ConsumerDropoffKind): InboundChannel {
  switch (kind) {
    case 'incentive':
      return 'incentive_dropoff';
    case 'unpaid':
      return 'unpaid_dropoff';
    case 'illegal':
      return 'illegal_dropoff';
    // ADR-0085 — both walk-up kinds share ONE channel. They differ only in the
    // word the operator tapped; for inventory and for billing they are the same
    // thing, and inventing two identical channels would imply a split that does
    // not exist. The Public/Incentive distinction survives on `kind`, which is
    // what the audit workbench groups by.
    case 'floor_public':
    case 'floor_incentive':
      return 'floor_dropoff';
  }
}

/**
 * Map a load's `load_source_type` + its source's non-program flag onto the canonical
 * channel. `event` wins regardless of the source flag (an event is an event). A
 * non-program source routes to `non_program`; otherwise a b2b/CIP haul is `mrc_program`.
 * Collection-site classification is a source-`site_type` property resolved by the caller
 * (it is not derivable from `load_source_type` alone), so callers that know the site is a
 * collection site pass `'collection'` directly.
 */
export function loadToChannel(
  loadSourceType: LoadSourceType,
  isNonProgram: boolean,
): InboundChannel {
  if (loadSourceType === 'event') return 'event';
  if (isNonProgram) return 'non_program';
  return 'mrc_program';
}
