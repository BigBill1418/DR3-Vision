// BS-10 — the floor's UPPER bound, decided once.
//
// `FloorInventoryTileData.negative` already exists and its comment says why it is
// computed in the builder rather than in each component: "it is decided HERE so the
// tile and the daily report cannot disagree about when a floor has gone impossible."
// That reasoning was only ever applied downward. There was no upper bound anywhere,
// which is why Woodland's floor rendered 11,020 program units in a 3,500-unit
// building, at `text-5xl` on the operator iPad and on six other surfaces, for six
// days, with nothing saying a word.
//
// FLAG, DO NOT CLAMP. A floor over its cap can be a genuine operational emergency
// (too many mattresses actually in the building) or a broken ledger, and this module
// cannot tell which. Clamping would hide the first and silently falsify the second.
// What it must never do again is render as an ordinary quantity.
//
// Pure: no DB, no clock. The capacity numbers come from `sites`.

/** The two jurisdiction-specific cap columns, as `sites` records them. */
export interface CapacityInputs {
  /** CA (Woodland) grades against the indoor cap. */
  maxUnitsIndoor: number | null;
  /** OR (Eugene) grades against the total on-site cap. */
  maxUnitsTotalOnSite: number | null;
}

export interface FloorCapacityState {
  /** The site's permitted maximum, or null when none is recorded. */
  capacity: number | null;
  /** True only when a cap exists and a NON-NEGATIVE floor strictly exceeds it. */
  overCapacity: boolean;
  /** Floor as a whole-number percentage of capacity, or null without a cap. */
  pctOfCapacity: number | null;
}

/**
 * Resolve a floor total against the site's permitted storage.
 *
 * Capacity is `max_units_total_on_site + max_units_indoor` with nulls as zero —
 * reusing the definition `metric6StorageInventory` in `compliance.ts` already uses,
 * rather than inventing a second one. CA records one, OR the other; there is no
 * outdoor addend (ADR-0037 addendum 2026-07-22).
 */
export function floorCapacityState(totalOnFloor: number, caps: CapacityInputs): FloorCapacityState {
  const capacity = (caps.maxUnitsTotalOnSite ?? 0) + (caps.maxUnitsIndoor ?? 0);
  if (capacity <= 0) {
    // No cap on file. "Unknown" must not render as "over" and must not render as
    // "fine" — the component shows the number and makes no capacity claim.
    return { capacity: null, overCapacity: false, pctOfCapacity: null };
  }
  return {
    capacity,
    // Strictly greater: at capacity is FULL, not impossible. Flagging a full floor
    // would make the warning routine, and a routine warning is one nobody reads.
    //
    // `totalOnFloor >= 0` because a negative floor is already `negative`'s business.
    // Reporting one number as both impossible-low and impossible-high is noise that
    // discredits both flags.
    overCapacity: totalOnFloor >= 0 && totalOnFloor > capacity,
    pctOfCapacity: Math.round((totalOnFloor / capacity) * 100),
  };
}
