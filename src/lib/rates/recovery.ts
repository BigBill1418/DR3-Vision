// ADR-0043 D1 — recovery rate (by UNITS, OR formula shape).
//
//   (processed + renovated_whole_units)
//   ─────────────────────────────────────────────────────────
//   (processed + renovated_whole_units + landfilled_units)
//
// The renovation channel counts per MRC rules (mission §2.1(2)) — whole units
// sold to a renovator are RECOVERED, not disposed. `processed` is the stripped /
// deconstructed unit count (the billing basis); `landfilled_units` is whole-unit
// disposal.
//
// Units-based, so the 55-lb weight estimate never enters — `estimatedInputs` is
// always false here (the estimate only touches the weight-based recycling rate).

import { noDataResult, type RateResult } from './types';

export interface RecoveryRateInput {
  /** Stripped / deconstructed units in the window (the billing basis). */
  processedUnits: number;
  /** Whole units sold to the renovation channel — credited as recovered. */
  renovatedWholeUnits: number;
  /** Whole units landfilled in the window. */
  landfilledUnits: number;
}

export function recoveryRate(input: RecoveryRateInput): RateResult {
  const processedUnits = Math.max(0, input.processedUnits);
  const renovatedWholeUnits = Math.max(0, input.renovatedWholeUnits);
  const landfilledUnits = Math.max(0, input.landfilledUnits);

  const recovered = processedUnits + renovatedWholeUnits;
  const components: Record<string, number> = {
    processedUnits,
    renovatedWholeUnits,
    landfilledUnits,
    recovered,
  };

  const numerator = recovered;
  const denominator = recovered + landfilledUnits;
  if (denominator === 0) return noDataResult(components, false);

  return { rate: numerator / denominator, numerator, denominator, components, estimatedInputs: false, noData: false };
}
