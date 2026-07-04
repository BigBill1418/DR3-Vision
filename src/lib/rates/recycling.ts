// ADR-0043 D1 — recycling rate (by WEIGHT).
//
//   recycled_lbs ÷ (recycled_lbs + disposed_lbs)
//
// `recycled_lbs` = Σ `outbound_materials.weight_lbs` for non-`trash` commodities
// (all sub-categories). `disposed_lbs` = `trash` weights + `landfilled_units.units
// × unit_weight_estimate` (55 lb).
//
// CONSERVATIVE `trash` HANDLING (pending Addendum B10-5): `trash` is counted
// DISPOSED even where its vendor is waste-to-energy. This UNDER-counts the rate
// → the alert fires EARLY, never late. When the B10-5 destination mapping lands,
// a `trash` row whose destination is WTE flips to recycled per-row — no schema
// change, this function just reads a `destination`-aware split.

import { UNIT_WEIGHT_ESTIMATE_LBS, noDataResult, type RateResult } from './types';

export interface RecyclingRateInput {
  /** Outbound rows in the window: commodity + scale weight (lbs). */
  outbound: readonly { commodity: string; weightLbs: number | null }[];
  /** Total landfilled WHOLE units in the window (disposed; weight-estimated). */
  landfilledUnits: number;
  /** lbs per landfilled unit — defaults to the 55-lb Addendum-B estimate. */
  unitWeightEstimateLbs?: number;
}

export function recyclingRate(input: RecyclingRateInput): RateResult {
  const estimate = input.unitWeightEstimateLbs ?? UNIT_WEIGHT_ESTIMATE_LBS;

  let recycledLbs = 0;
  let trashLbs = 0;
  for (const row of input.outbound) {
    const lbs = row.weightLbs ?? 0;
    // `trash` is the only DISPOSED commodity today (B10-5 pending).
    if (row.commodity === 'trash') trashLbs += lbs;
    else recycledLbs += lbs;
  }

  const landfilledUnits = Math.max(0, input.landfilledUnits);
  const landfilledLbs = landfilledUnits * estimate;
  const disposedLbs = trashLbs + landfilledLbs;

  // The 55-lb estimate contributed iff any landfilled unit fed the denominator.
  const estimatedInputs = landfilledUnits > 0;

  const components: Record<string, number> = {
    recycledLbs,
    trashLbs,
    landfilledUnits,
    landfilledLbs,
    unitWeightEstimateLbs: estimate,
    disposedLbs,
  };

  const numerator = recycledLbs;
  const denominator = recycledLbs + disposedLbs;
  if (denominator === 0) return noDataResult(components, estimatedInputs);

  return { rate: numerator / denominator, numerator, denominator, components, estimatedInputs, noData: false };
}
