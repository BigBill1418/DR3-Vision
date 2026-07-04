// ADR-0043 D1 — pure rate computations. No comparator/tile reads a DB or a
// clock here; every input is pre-aggregated and passed in.

export { UNIT_WEIGHT_ESTIMATE_LBS, noDataResult, type RateResult } from './types';
export { recyclingRate, type RecyclingRateInput } from './recycling';
export { recoveryRate, type RecoveryRateInput } from './recovery';
export { resolveRateThresholds, type RateThresholds } from './thresholds';
export { aggregateSiteRates, type RateInputs } from './aggregate';
