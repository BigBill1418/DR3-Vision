// R2 — Recovery rate (by units, renovation-inclusive) below floor + margin.
//
// Same grading pattern as R1 (floor + warn/high margins, data-editable), over
// the units-based `recoveryRate` computation. The renovation channel is credited
// into the numerator per MRC rules (mission §2.1(2)).

import type { RateResult } from '@/lib/rates';
import type { AuditWindow, CheckConfig, Finding } from '../types';
import { buildRateFindings, type RateThresholds } from './rate-check';

export function r2RecoveryRate(
  window: AuditWindow,
  rate: RateResult,
  config: CheckConfig,
  thresholds: RateThresholds,
  jurisdiction: string,
): Finding[] {
  return buildRateFindings({
    checkCode: 'r2_recovery_rate',
    metric: 'recovery_rate',
    window,
    config,
    rate,
    thresholds,
    jurisdiction,
  });
}
