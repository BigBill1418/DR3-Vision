// ADR-0043 — per-jurisdiction rate thresholds (contract floor + margins).
//
// Floors are DATA (editable via `audit_check_config` params): CA 75 / OR 70.
// A rate below `floor + warn_margin_pts` warns; below `floor + high_margin_pts`
// escalates to high. Shared by the R1/R2 comparators and the dashboard tiles so
// the tile floor and the check floor never drift.

export interface RateThresholds {
  /** Contract floor, percent (e.g. 75). */
  floorPct: number;
  /** Warn margin, percentage points above the floor (e.g. 3). */
  warnMarginPts: number;
  /** High-severity margin, percentage points above the floor (e.g. 1). */
  highMarginPts: number;
}

/** Resolve thresholds from an R-check config's `params` + the site jurisdiction. */
export function resolveRateThresholds(
  params: Record<string, unknown>,
  jurisdiction: string,
): RateThresholds {
  const num = (k: string, d: number): number => {
    const v = params[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const floorPct = jurisdiction === 'california' ? num('ca_floor_pct', 75) : num('or_floor_pct', 70);
  return { floorPct, warnMarginPts: num('warn_margin_pts', 3), highMarginPts: num('high_margin_pts', 1) };
}
