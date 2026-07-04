// ADR-0043 D3 — dashboard rate-tile data (server-side composition).
//
// Computes the two site rate tiles (recycling by weight, recovery by units) over
// the same rolling window and thresholds the nightly R1/R2 checks use — so the
// tile a manager sees never drifts from the finding the sweep raises. Reads are
// site-scoped (CLAUDE.md hard rule #2). Pure grading is delegated to the audit
// comparator's `gradeRate`; the aggregation to `rates/aggregate`.

import { prisma } from '@/lib/prisma';
import { appTodayISO, dayISO, dayKeyUTCFromISO } from '@/lib/time';
import { aggregateSiteRates, resolveRateThresholds, type RateResult, type RateThresholds } from '@/lib/rates';
import { gradeRate } from '@/lib/audit/comparators';
import { resolveCheckConfigs } from '@/lib/audit/config';
import type { CheckConfig, CheckCode } from '@/lib/audit/types';

export type RateTileStatus = 'ok' | 'warn' | 'high' | 'nodata';

export interface RateTileData {
  metric: 'recycling_rate' | 'recovery_rate';
  checkCode: Extract<CheckCode, 'r1_recycling_rate' | 'r2_recovery_rate'>;
  /** Current rolling rate, percent — null when there is no data to rate. */
  ratePct: number | null;
  /** Prior equal-length window, percent — for the trend arrow. */
  priorRatePct: number | null;
  /** current − prior, percentage points (null when either side has no data). */
  trendPts: number | null;
  floorPct: number;
  warnThresholdPct: number;
  status: RateTileStatus;
  /** True when the 55-lb unit-weight estimate contributed (shows the badge). */
  estimated: boolean;
  windowStartISO: string;
  windowEndISO: string;
}

export interface SiteRateTiles {
  recycling: RateTileData;
  recovery: RateTileData;
}

function shiftISO(iso: string, deltaDays: number): string {
  const d = dayKeyUTCFromISO(iso);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return dayISO(d);
}

function windowDaysFrom(cfg: CheckConfig | undefined): number {
  const v = cfg?.params['rate_window_days'];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 273;
}

/**
 * Compute both rate tiles for a site. Returns null when the site is unknown
 * (no jurisdiction to pick the floor). Never throws on empty data — a zero
 * denominator yields a `nodata` tile.
 */
export async function computeSiteRateTiles(
  siteId: string,
  jurisdiction: string,
  nowISO: string = appTodayISO(),
): Promise<SiteRateTiles> {
  const configRows = await prisma.auditCheckConfig.findMany({
    where: { OR: [{ site_id: null }, { site_id: siteId }] },
  });
  const configs = resolveCheckConfigs(siteId, configRows);
  const r1 = configs.get('r1_recycling_rate');
  const r2 = configs.get('r2_recovery_rate');

  const windowDays = windowDaysFrom(r1);
  const curStart = shiftISO(nowISO, -windowDays);
  const priorStart = shiftISO(nowISO, -windowDays * 2);

  const [current, prior] = await Promise.all([
    aggregateSiteRates(prisma, siteId, curStart, nowISO),
    aggregateSiteRates(prisma, siteId, priorStart, curStart),
  ]);

  const r1Thresholds = resolveRateThresholds(r1?.params ?? {}, jurisdiction);
  const r2Thresholds = resolveRateThresholds(r2?.params ?? {}, jurisdiction);

  const tile = (
    metric: RateTileData['metric'],
    checkCode: RateTileData['checkCode'],
    cur: RateResult,
    pri: RateResult,
    thresholds: RateThresholds,
  ): RateTileData => {
    const grade = gradeRate(cur, thresholds);
    const ratePct = cur.rate === null ? null : cur.rate * 100;
    const priorRatePct = pri.rate === null ? null : pri.rate * 100;
    const trendPts = ratePct !== null && priorRatePct !== null ? ratePct - priorRatePct : null;
    const status: RateTileStatus = cur.noData
      ? 'nodata'
      : !grade.breached
        ? 'ok'
        : grade.severity === 'high'
          ? 'high'
          : 'warn';
    return {
      metric,
      checkCode,
      ratePct,
      priorRatePct,
      trendPts,
      floorPct: thresholds.floorPct,
      warnThresholdPct: grade.warnThresholdPct,
      status,
      estimated: cur.estimatedInputs,
      windowStartISO: curStart,
      windowEndISO: nowISO,
    };
  };

  return {
    recycling: tile('recycling_rate', 'r1_recycling_rate', current.recycling, prior.recycling, r1Thresholds),
    recovery: tile('recovery_rate', 'r2_recovery_rate', current.recovery, prior.recovery, r2Thresholds),
  };
}
