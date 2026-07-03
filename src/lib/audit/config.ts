// ADR-0039 D1 — tolerance windows are DATA, not code.
//
// This module defines the seed defaults for `audit_check_config` and the
// resolver that turns DB rows into the runtime `CheckConfig` a comparator
// consumes. A global row (`site_id = null`) is the default; a per-site row
// (same check_code, site set) overrides it field-by-field.
//
// `ensureDefaultCheckConfig(db)` idempotently upserts the global defaults. It is
// called by the nightly sweep (self-healing) and is safe to call from the seed.

import type { CheckCode, CheckConfig, JsonValue, Severity } from './types';

/** Default tolerance / severity for one check (the global `site_id = null` row). */
export interface DefaultCheckConfig {
  checkCode: CheckCode;
  enabled: boolean;
  severity: Severity;
  unitTolerance: number;
  weightToleranceLbs: number;
  graceBusinessDays: number;
  openWindowDays: number | null;
  blocksBilling: boolean;
  params: Record<string, JsonValue>;
}

// Seeded defaults (ADR-0039 D1 + test plan). Notable rows:
//   - C3 tolerates same-day gaps until EOD+1 ⇒ graceBusinessDays = 1.
//   - C4 billing basis carries the 45-day vendor open window (Kelsey Q8) and
//     is the anchor for the billing-gate min-blocking-severity param.
//   - C7 deadline clocks live in params: inbound 3 business days, processed 1,
//     outbound 3 (from EOD). Reused/overridable from the Site row at fetch time.
export const DEFAULT_CHECK_CONFIGS: readonly DefaultCheckConfig[] = [
  {
    checkCode: 'c1_inbound',
    enabled: true,
    severity: 'high',
    unitTolerance: 0,
    weightToleranceLbs: 0,
    graceBusinessDays: 0,
    openWindowDays: null,
    blocksBilling: true,
    params: {},
  },
  {
    checkCode: 'c2_processed',
    enabled: true,
    severity: 'high',
    unitTolerance: 0,
    weightToleranceLbs: 0,
    graceBusinessDays: 0,
    openWindowDays: null,
    blocksBilling: true,
    params: {},
  },
  {
    checkCode: 'c3_outbound',
    enabled: true,
    severity: 'medium',
    unitTolerance: 0,
    weightToleranceLbs: 50, // scale-weight jitter tolerance (lbs)
    graceBusinessDays: 1, // EOD+1 — outbound is finalized to MyMRC at end of day
    openWindowDays: null,
    blocksBilling: true,
    params: {},
  },
  {
    checkCode: 'c4_billing_basis',
    enabled: true,
    severity: 'critical',
    unitTolerance: 0,
    weightToleranceLbs: 0,
    graceBusinessDays: 0,
    openWindowDays: 45, // vendor invoices settle up to a month+ later (Kelsey Q8)
    blocksBilling: true,
    // The billing trust gate blocks a window with any open finding at or above
    // this severity (ADR-0039 D5). Stored here so the threshold is data.
    params: { min_blocking_severity: 'high' },
  },
  {
    checkCode: 'c5_conservation',
    enabled: true,
    severity: 'critical',
    unitTolerance: 0,
    weightToleranceLbs: 0,
    graceBusinessDays: 0,
    openWindowDays: null,
    blocksBilling: true,
    params: {},
  },
  {
    checkCode: 'c6_inventory_continuity',
    enabled: true,
    severity: 'high',
    unitTolerance: 0,
    weightToleranceLbs: 0,
    graceBusinessDays: 0,
    openWindowDays: null,
    blocksBilling: false, // a continuity break is a data-quality flag, not a billing block by default
    params: {},
  },
  {
    checkCode: 'c7_deadline',
    enabled: true,
    severity: 'medium',
    unitTolerance: 0,
    weightToleranceLbs: 0,
    graceBusinessDays: 0,
    openWindowDays: null,
    blocksBilling: false,
    params: { inbound_business_days: 3, processed_business_days: 1, outbound_business_days: 3 },
  },
  {
    checkCode: 'summary_recompute',
    enabled: true,
    severity: 'high',
    unitTolerance: 0,
    weightToleranceLbs: 0,
    graceBusinessDays: 0,
    openWindowDays: null,
    blocksBilling: true,
    params: {},
  },
];

/** Turn a default into a runtime `CheckConfig`. */
export function toCheckConfig(d: DefaultCheckConfig): CheckConfig {
  return {
    checkCode: d.checkCode,
    enabled: d.enabled,
    severity: d.severity,
    unitTolerance: d.unitTolerance,
    weightToleranceLbs: d.weightToleranceLbs,
    graceBusinessDays: d.graceBusinessDays,
    openWindowDays: d.openWindowDays,
    blocksBilling: d.blocksBilling,
    params: d.params,
  };
}

/** The full default `CheckConfig` map (used when the DB has no override). */
export function defaultCheckConfigMap(): Map<CheckCode, CheckConfig> {
  const m = new Map<CheckCode, CheckConfig>();
  for (const d of DEFAULT_CHECK_CONFIGS) m.set(d.checkCode, toCheckConfig(d));
  return m;
}

// ────────────────────────────────────────────────────────────────────────
// DB resolution — global default overlaid by a per-site row
// ────────────────────────────────────────────────────────────────────────

/** The subset of an `audit_check_config` DB row the resolver reads. */
export interface CheckConfigRow {
  site_id: string | null;
  check_code: CheckCode;
  enabled: boolean;
  severity: Severity;
  unit_tolerance: number;
  weight_tolerance_lbs: number;
  grace_business_days: number;
  open_window_days: number | null;
  blocks_billing: boolean;
  params: unknown;
}

function rowToConfig(row: CheckConfigRow): CheckConfig {
  return {
    checkCode: row.check_code,
    enabled: row.enabled,
    severity: row.severity,
    unitTolerance: row.unit_tolerance,
    weightToleranceLbs: row.weight_tolerance_lbs,
    graceBusinessDays: row.grace_business_days,
    openWindowDays: row.open_window_days,
    blocksBilling: row.blocks_billing,
    params: (row.params && typeof row.params === 'object'
      ? (row.params as Record<string, JsonValue>)
      : {}),
  };
}

/**
 * Resolve the effective `CheckConfig` per check for a site: start from the
 * seeded defaults, overlay the global (`site_id = null`) DB rows, then overlay
 * the per-site rows. Pure over the provided rows so it is unit-testable without
 * a DB.
 */
export function resolveCheckConfigs(
  siteId: string,
  rows: readonly CheckConfigRow[],
): Map<CheckCode, CheckConfig> {
  const map = defaultCheckConfigMap();
  const globals = rows.filter((r) => r.site_id === null);
  const perSite = rows.filter((r) => r.site_id === siteId);
  for (const r of globals) map.set(r.check_code, rowToConfig(r));
  for (const r of perSite) map.set(r.check_code, rowToConfig(r));
  return map;
}

/** Read the billing-gate min blocking severity from resolved config (D5). */
export function gateMinBlockingSeverity(configs: Map<CheckCode, CheckConfig>): Severity {
  const c4 = configs.get('c4_billing_basis');
  const raw = c4?.params['min_blocking_severity'];
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'critical') return raw;
  return 'high';
}
