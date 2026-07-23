// ADR-0037 (Rick/Morena definitive rules, 2026-07-23) — the SINGLE effective
// program/non-program determination for an inbound source. This is BILLING-CRITICAL:
// MRC is billed on PROGRAM units only, so mis-classifying a source silently mis-states
// the billable pool.
//
// A mattress source is NON-PROGRAM if EITHER:
//
//   1. EXPLICIT — the source is flagged `is_non_program` (a "charging" collection site
//      DR3 pays to collect from, an SVDP internal store, a parked non-MRC site, etc.).
//      The explicit CA (Woodland) charging list — Golden Bear, Monte Diablo, San Martin,
//      Martinez, Petaluma, Sonoma, Annapolis, Healdsburg, Vasco, Brentwood — plus the OR
//      (Eugene) Roseburg + Recyclops are seeded with `is_non_program = true`
//      (migration 20260809_adr0037_nonprogram_charging_sources).
//
//   2. OUT-OF-STATE — the units' GENERATED location's state (`source.state`) is KNOWN and
//      differs from the RECYCLER's operating state (Woodland = CA, Eugene = OR). This is
//      about where the mattresses were generated, NOT the hauler's HQ. An Oregon-generated
//      load delivered to Woodland (CA) is non-program even without the explicit flag.
//
// DEFAULT = program when neither applies. A NULL/blank `source.state` is UNKNOWN — it
// falls back to the explicit flag ONLY and never guesses out-of-state (a missing state is
// not evidence of out-of-state; guessing would over-attribute to the non-billable pool).
//
// This module is the ONE place the rule lives; every path that classifies a source's units
// (the verify gate's default split, the workbook-promotion alias resolver) calls it, so the
// two rules can never drift between paths. Pure — no DB, no clock — fully unit-testable.

import type { Jurisdiction } from '@prisma/client';

/** The recycler's operating state — the two states DR3 recycles in. */
export type RecyclerState = 'CA' | 'OR';

/**
 * The recycler's operating state for a site's jurisdiction — the schema-native source of
 * truth (Woodland = `california` → CA; Eugene = `oregon` → OR). No hard-coded site-id map:
 * `sites.jurisdiction` already carries this, so a new site classifies correctly for free.
 */
export function recyclerStateForJurisdiction(jurisdiction: Jurisdiction): RecyclerState {
  return jurisdiction === 'california' ? 'CA' : 'OR';
}

/** Case/whitespace-insensitive state comparison ('ca', ' CA ', 'Ca' all match 'CA'). */
function normalizeState(s: string): string {
  return s.trim().toUpperCase();
}

/** The minimal source shape the effective-classification rule reads. */
export interface SourceClassificationFields {
  is_non_program: boolean;
  /** The source's GENERATED-location state (two-letter, e.g. 'CA'). NULL/blank = unknown. */
  state: string | null;
}

/**
 * EFFECTIVE non-program determination (the definitive rule). Returns true when the
 * source's units belong in the NON-PROGRAM (non-billable) pool: either the explicit
 * `is_non_program` flag is set, or the source's known state differs from the recycler's
 * operating state (out-of-state). A NULL/blank state falls back to the flag only.
 */
export function isSourceNonProgram(
  source: SourceClassificationFields,
  recyclerState: RecyclerState,
): boolean {
  if (source.is_non_program) return true;
  if (source.state != null && source.state.trim() !== '') {
    return normalizeState(source.state) !== normalizeState(recyclerState);
  }
  return false;
}
