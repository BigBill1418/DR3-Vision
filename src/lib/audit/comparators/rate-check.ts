// ADR-0043 D2 — shared R-check (rate-below-floor) grading + finding builder.
//
// R1 (recycling) and R2 (recovery) are structurally identical: a `RateResult`
// (from `src/lib/rates`) is graded against a contract floor + margins, and a
// breach becomes ONE window-normalized finding per site. Fingerprint keys on
// `[siteId]` (not the rolling window dates) so a persisting low rate UPDATEs the
// same finding nightly rather than spawning duplicates; when the rate recovers,
// the sweep emits nothing and the finding auto-resolves.

import type { RateResult, RateThresholds } from '@/lib/rates';
import type { AuditWindow, CheckCode, CheckConfig, Finding, Severity } from '../types';
import { makeFinder } from './helpers';

export type { RateThresholds };

export interface RateGrade {
  breached: boolean;
  severity: Severity;
  ratePct: number | null;
  warnThresholdPct: number;
  highThresholdPct: number;
}

/**
 * Grade a rate against `floor + margin`. Boundary is inclusive-safe: a rate
 * exactly at `floor + warn_margin` is NOT a breach (`>=` is clean); strictly
 * below `floor + high_margin` escalates to `high`.
 */
export function gradeRate(rate: RateResult, t: RateThresholds): RateGrade {
  const warnThresholdPct = t.floorPct + t.warnMarginPts;
  const highThresholdPct = t.floorPct + t.highMarginPts;
  if (rate.noData || rate.rate === null) {
    return { breached: false, severity: 'medium', ratePct: null, warnThresholdPct, highThresholdPct };
  }
  const ratePct = rate.rate * 100;
  if (ratePct >= warnThresholdPct) {
    return { breached: false, severity: 'medium', ratePct, warnThresholdPct, highThresholdPct };
  }
  const severity: Severity = ratePct < highThresholdPct ? 'high' : 'medium';
  return { breached: true, severity, ratePct, warnThresholdPct, highThresholdPct };
}

/**
 * Build the R-check findings for one metric. `metric` distinguishes the two
 * dashboards ('recycling_rate' | 'recovery_rate'); `checkCode` is the enum row.
 * No-data (zero denominator) → no finding (nothing to grade). Emits at most one.
 */
export function buildRateFindings(args: {
  checkCode: Extract<CheckCode, 'r1_recycling_rate' | 'r2_recovery_rate'>;
  metric: 'recycling_rate' | 'recovery_rate';
  window: AuditWindow;
  config: CheckConfig;
  rate: RateResult;
  thresholds: RateThresholds;
  jurisdiction: string;
}): Finding[] {
  if (!args.config.enabled) return [];
  const grade = gradeRate(args.rate, args.thresholds);
  if (!grade.breached) return [];

  const finding = makeFinder(args.checkCode, args.window, args.config);
  return [
    finding({
      kind: 'value_mismatch',
      keys: [args.window.siteId], // window-normalized: one finding per site
      severity: grade.severity,
      legARef: null,
      legBRef: null,
      expected: {
        floorPct: args.thresholds.floorPct,
        warnThresholdPct: grade.warnThresholdPct,
        highThresholdPct: grade.highThresholdPct,
      },
      actual: { ratePct: grade.ratePct },
      detail: {
        metric: args.metric,
        jurisdiction: args.jurisdiction,
        numerator: args.rate.numerator,
        denominator: args.rate.denominator,
        components: args.rate.components,
        estimated: args.rate.estimatedInputs,
        windowStartISO: args.window.startISO,
        windowEndISO: args.window.endISO,
      },
    }),
  ];
}
