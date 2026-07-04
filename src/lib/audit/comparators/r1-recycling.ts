// R1 — Recycling rate (by weight) below the contract floor + margin.
//
// CA floor 75 / OR floor 70 (data, editable); a rate below floor+3pts warns,
// below floor+1pt is high. The rate itself is the PURE `recyclingRate`
// computation over a rolling ~9-month window; this comparator only grades it and
// emits the (window-normalized) finding. See `rate-check.ts` for the shared
// grading; the leg-fetcher resolves the jurisdiction floor and computes the rate.

import type { RateResult } from '@/lib/rates';
import type { AuditWindow, CheckConfig, Finding } from '../types';
import { buildRateFindings, type RateThresholds } from './rate-check';

export function r1RecyclingRate(
  window: AuditWindow,
  rate: RateResult,
  config: CheckConfig,
  thresholds: RateThresholds,
  jurisdiction: string,
): Finding[] {
  return buildRateFindings({
    checkCode: 'r1_recycling_rate',
    metric: 'recycling_rate',
    window,
    config,
    rate,
    thresholds,
    jurisdiction,
  });
}
