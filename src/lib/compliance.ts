// SPRINT-1-PLAN T-012 — Compliance dashboard aggregations.
//
// Pure aggregation functions, one per contract-tracked metric defined in
// `docs/COMPLIANCE.md`. Each function is shaped identically:
//
//   ({ siteId, periodStart, periodEnd, site }) => Promise<MetricResult>
//
// where `site` carries the per-site thresholds we already loaded once at
// the page level (so each metric doesn't re-read the row). All thresholds
// come from the `Site` row — never hardcoded — per CLAUDE.md hard rule #2
// (per-site separation). Every Prisma query in this module scopes by
// `site_id` for the same reason.
//
// Per CLAUDE.md hard rule #5 nothing here calls into ntfy / `email.ts` /
// any push-notification helper. The dashboard is in-app signals only;
// rendering a "yellow" or "red" tile is the entire user-facing contract.
//
// The `clickThroughHref` returned by each metric uses the URL vocabulary
// established by T-011's load list (`?range=`, `?from`, `?to`, `?status=`,
// `?source_id`, `?operator_id`, `?transporter_id`) so a manager tapping a
// tile lands on a pre-filtered list of the loads behind the number.

import { prisma } from '@/lib/prisma';
import { LoadStatus, type Site } from '@prisma/client';

// ────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────

/** Bucket the tile renders against; stable for color + sort order. */
export type ComplianceBucket = 'green' | 'yellow' | 'red' | 'pending';

/**
 * One metric result. The page renders one tile per result.
 *
 * - `value` is the metric's primary number (a percentage 0–100, a unit
 *   count, a years-remaining count — depends on the metric).
 * - `threshold` is the contract target the value is graded against.
 * - `unit` is what to render after the number ('%', 'units', 'yrs', '').
 * - `bucket` is the color band per the rubric below.
 * - `rowCount` is the in-scope row count for the caption ("N loads in scope").
 * - `clickThroughHref` deep-links into T-011's load list (or another page,
 *   for metric #5 / #7) with the right pre-filter.
 * - `caption` is an optional one-liner shown under the threshold (used for
 *   the recycling rate's "12-month rolling" note, the retention years
 *   remaining, etc.).
 *
 * Bucket rubric (per the T-012 brief):
 *   green:  value meets the threshold
 *   yellow: value is within 5pp of the threshold (or equivalent band)
 *   red:    value is below threshold − 5pp
 *   pending: data source not yet wired (V2.1 metrics, etc.)
 */
export interface MetricResult {
  value: number;
  threshold: number;
  unit: '%' | 'units' | 'yrs' | '';
  bucket: ComplianceBucket;
  rowCount: number;
  clickThroughHref: string;
  caption?: string;
}

export interface MetricInput {
  siteId: string;
  siteCode: string;
  site: Pick<
    Site,
    | 'recycling_rate_target_pct'
    | 'reconciliation_target_pct'
    | 'records_retention_years'
    | 'mymrc_inbound_submission_business_days'
    | 'mymrc_processed_submission_business_days'
    | 'dock_sla_minutes'
    | 'inbound_processing_deadline_days'
    | 'max_units_indoor'
    | 'max_units_outdoor'
    | 'max_units_total_on_site'
  >;
  periodStart: Date;
  periodEnd: Date;
  /** Holiday dates (UTC midnight) for this site, used by business-day math. */
  holidays: Date[];
}

// ────────────────────────────────────────────────────────────────────────
// Business-day math
// ────────────────────────────────────────────────────────────────────────

/**
 * Add `n` business days to `date`, skipping Saturdays + Sundays + the
 * supplied holiday set.
 *
 * Edge cases:
 *  - n=0 returns the same instant; no normalisation happens.
 *  - Negative n is supported (walks backward).
 *  - Holidays compare on the calendar-day key in UTC. Per-site holidays
 *    only — there is no built-in US-federal holiday list. The seed data
 *    populates the federal list per site (24 rows per
 *    `prisma/seed/site_holidays.csv`); this keeps the math jurisdiction-
 *    aware (Eugene observes OR holidays, Woodland observes CA holidays
 *    once that's wired).
 *  - DST is irrelevant: the math operates on whole-day increments and
 *    the calendar-day key is taken in UTC.
 */
export function addBusinessDays(date: Date, n: number, holidays: Date[]): Date {
  const holidaySet = new Set(holidays.map((h) => calendarKey(h)));
  const out = new Date(date.getTime());
  if (n === 0) return out;
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + step);
    const dow = out.getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    if (holidaySet.has(calendarKey(out))) continue;
    remaining--;
  }
  return out;
}

function calendarKey(d: Date): string {
  // YYYY-MM-DD in UTC. The seed loads holidays as `T00:00:00Z`, so this
  // matches without any locale juggling.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ────────────────────────────────────────────────────────────────────────
// Bucket helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Standard "value vs percentage threshold" grading. Yellow band is
 * threshold-5pp..threshold; red below. Used by metrics #1, #2, #3, #4, #5.
 */
function bucketForPctMetric(value: number, threshold: number): ComplianceBucket {
  if (value >= threshold) return 'green';
  if (value >= threshold - 5) return 'yellow';
  return 'red';
}

/**
 * Storage inventory grading. Threshold here is the site limit (a unit
 * count, not a percentage), so we grade against capacity utilization.
 * COMPLIANCE.md says ntfy fires at 90% capacity (out of scope here);
 * the in-app dashboard signals at 80% yellow per the alert matrix.
 */
function bucketForCapacity(usedUnits: number, capacityUnits: number): ComplianceBucket {
  if (capacityUnits <= 0) return 'pending';
  const pct = (usedUnits / capacityUnits) * 100;
  if (pct >= 90) return 'red';
  if (pct >= 80) return 'yellow';
  return 'green';
}

/**
 * Records retention grading. `value` is years until the oldest in-window
 * record falls off the cliff (positive = within window with margin, zero
 * or negative = at/past cliff). Yellow within 1 year of cliff.
 */
function bucketForRetention(yearsRemaining: number): ComplianceBucket {
  if (yearsRemaining < 0) return 'red';
  if (yearsRemaining < 1) return 'yellow';
  return 'green';
}

// ────────────────────────────────────────────────────────────────────────
// Period helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * URL `range`/`from`/`to` for the load-list deep link. Re-emits the same
 * window the dashboard is showing so the click-through context matches.
 */
function periodQueryFragments(periodStart: Date, periodEnd: Date): string {
  const fromIso = isoDate(periodStart);
  // T-011's `to` is inclusive at the day level (it adds +1 day server-
  // side to make it half-open). The dashboard's periodEnd is the
  // exclusive upper bound; subtract 1 day for the inclusive `to` param.
  const inclusiveEnd = new Date(periodEnd.getTime());
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
  const toIso = isoDate(inclusiveEnd);
  return `range=custom&from=${fromIso}&to=${toIso}`;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ────────────────────────────────────────────────────────────────────────
// Metric 1 — MyMRC submission timeliness (≥95% within N business days)
// ────────────────────────────────────────────────────────────────────────

/**
 * Numerator/denominator definition (from `docs/COMPLIANCE.md` §1):
 *   numerator   = loads submitted to MyMRC within N business days of arrival
 *   denominator = loads in the period that are eligible for submission
 *
 * Schema gap: there is no `submitted_to_mymrc_at` column today. The
 * status flips to `submitted_to_mymrc` when the V2.1 MyMRC submission
 * lands; that flip is captured in `audit_log.created_at`. For T-012 we
 * use a proxy — `mymrc_submission_deadline` already exists on the load
 * (set when `arrived_at` lands, so it pre-bakes the business-day math).
 * Two reads:
 *   - denominator = loads in the period with `arrived_at != null`
 *     (`expected` rows have no arrival yet and aren't on the clock)
 *     and that have already passed their deadline OR are status
 *     `submitted_to_mymrc`/`processed`. Pre-deadline loads can't be
 *     "late" yet, so they're excluded from grading — matches MRC's
 *     own measurement window.
 *   - numerator = loads in the denominator whose status is
 *     `submitted_to_mymrc` or `processed` AND whose `updated_at` is
 *     <= deadline. `updated_at` is the closest stand-in for the status
 *     flip until the explicit timestamp column lands.
 *
 * Becomes exact when the dedicated `submitted_to_mymrc_at` column is
 * added — flagged as a follow-up below.
 */
async function metric1MyMrcSubmissionTimeliness(input: MetricInput): Promise<MetricResult> {
  const target = 95;
  const where = {
    site_id: input.siteId,
    arrived_at: { gte: input.periodStart, lt: input.periodEnd },
  } as const;

  // Denominator: loads in the window that are eligible for grading
  // (passed deadline OR already advanced past submitted).
  const candidates = await prisma.inboundLoad.findMany({
    where,
    select: {
      status: true,
      mymrc_submission_deadline: true,
      updated_at: true,
    },
  });

  const now = new Date();
  let onTime = 0;
  let late = 0;
  for (const row of candidates) {
    const deadline = row.mymrc_submission_deadline;
    const submitted =
      row.status === LoadStatus.submitted_to_mymrc || row.status === LoadStatus.processed;
    if (submitted) {
      if (deadline && row.updated_at && row.updated_at.getTime() <= deadline.getTime()) {
        onTime++;
      } else {
        late++;
      }
    } else if (deadline && deadline.getTime() < now.getTime()) {
      // Past deadline but never submitted — counts against the rate.
      late++;
    }
    // Pre-deadline + un-submitted loads aren't graded yet.
  }

  const denom = onTime + late;
  const value = denom === 0 ? 100 : Math.round((onTime / denom) * 1000) / 10;
  return {
    value,
    threshold: target,
    unit: '%',
    bucket: denom === 0 ? 'green' : bucketForPctMetric(value, target),
    rowCount: denom,
    // Click-through: the late + un-submitted subset.
    clickThroughHref: `/dashboard/${input.siteCode}/loads?${periodQueryFragments(
      input.periodStart,
      input.periodEnd,
    )}&status=submitted,verified,rejected`,
    caption: `${onTime}/${denom} on time · ${input.site.mymrc_inbound_submission_business_days}-day window`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Metric 2 — Processed-units submission (≥95% within N business days)
// ────────────────────────────────────────────────────────────────────────

/**
 * Per `docs/COMPLIANCE.md` §2:
 *   numerator   = processing sessions submitted to MyMRC within
 *                 `mymrc_processed_submission_business_days` of `session_date`
 *   denominator = sessions in the period that are eligible for grading
 *                 (past their submission deadline OR already submitted)
 *
 * Schema source: `processing_sessions` exists with the fields we need
 * (`session_date`, `submitted_to_mymrc_at`). The Processor Form
 * workflow (ADR-0011 / V2.1) writes this table; the operator load path
 * does not. While V2.1 is unshipped the table is empty and the metric
 * grades green-by-convention (denom=0 ⇒ 100%). Once V2.1 writes
 * sessions the same code path produces the real ratio without
 * redeployment.
 *
 * Period scoping uses `session_date` (the canonical date the
 * submission deadline runs from) intersected with the dashboard
 * window. Like metric #1 we exclude pre-deadline + un-submitted
 * sessions from grading — they can't be "late" yet — to match MRC's
 * own measurement.
 */
async function metric2ProcessedUnitsSubmission(input: MetricInput): Promise<MetricResult> {
  const target = 95;
  const businessDays = input.site.mymrc_processed_submission_business_days;

  const sessions = await prisma.processingSession.findMany({
    where: {
      site_id: input.siteId,
      session_date: { gte: input.periodStart, lt: input.periodEnd },
    },
    select: {
      session_date: true,
      submitted_to_mymrc_at: true,
    },
  });

  const now = new Date();
  let onTime = 0;
  let late = 0;
  for (const row of sessions) {
    const deadline = addBusinessDays(row.session_date, businessDays, input.holidays);
    if (row.submitted_to_mymrc_at) {
      if (row.submitted_to_mymrc_at.getTime() <= deadline.getTime()) {
        onTime++;
      } else {
        late++;
      }
    } else if (deadline.getTime() < now.getTime()) {
      // Past deadline but never submitted — counts against the rate.
      late++;
    }
    // Pre-deadline + un-submitted sessions aren't graded yet.
  }

  const denom = onTime + late;
  const value = denom === 0 ? 100 : Math.round((onTime / denom) * 1000) / 10;
  // Click-through: the load list filtered to the late + un-submitted
  // subset for this period. There is no T-011-style processing-session
  // list yet (V2.1), so we deep-link to the load list scoped to the
  // window — same surface T-012's other metrics use.
  const href = `/dashboard/${input.siteCode}/loads?${periodQueryFragments(
    input.periodStart,
    input.periodEnd,
  )}&status=processed`;
  if (sessions.length === 0) {
    // Empty corpus: real query, but no data to grade. Rather than
    // claim "100% on time" with zero observations, surface the
    // honest "no sessions in scope" state — still green because no
    // contract violation, but caption tells the truth.
    return {
      value: 100,
      threshold: target,
      unit: '%',
      bucket: 'green',
      rowCount: 0,
      clickThroughHref: href,
      caption: `0 sessions in scope · ${businessDays}-day window`,
    };
  }
  return {
    value,
    threshold: target,
    unit: '%',
    bucket: bucketForPctMetric(value, target),
    rowCount: denom,
    clickThroughHref: href,
    caption: `${onTime}/${denom} on time · ${businessDays}-day window`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Metric 3 — Dock-appointment SLA (≥90% within N minutes)
// ────────────────────────────────────────────────────────────────────────

/**
 * Definition: percentage of loads whose `unload_started_at` lands within
 * `dock_sla_minutes` of `arrived_at`. Per COMPLIANCE.md §3 the SLA
 * actually starts at the `scheduled_appointment_at`; in MVP very few
 * loads have that scheduled timestamp populated (it comes from the
 * MyMRC scrape — T-015), so we measure off `arrived_at` which is the
 * timestamp every load reliably has. Becomes exact when T-015 lands.
 */
async function metric3DockSla(input: MetricInput): Promise<MetricResult> {
  const target = 90;
  const slaSeconds = input.site.dock_sla_minutes * 60;

  const rows = await prisma.inboundLoad.findMany({
    where: {
      site_id: input.siteId,
      arrived_at: { gte: input.periodStart, lt: input.periodEnd, not: null },
      unload_started_at: { not: null },
    },
    select: { time_to_unload_start_seconds: true },
  });

  let onTime = 0;
  let late = 0;
  for (const r of rows) {
    if (r.time_to_unload_start_seconds === null) continue;
    if (r.time_to_unload_start_seconds <= slaSeconds) onTime++;
    else late++;
  }
  const denom = onTime + late;
  const value = denom === 0 ? 100 : Math.round((onTime / denom) * 1000) / 10;
  return {
    value,
    threshold: target,
    unit: '%',
    bucket: denom === 0 ? 'green' : bucketForPctMetric(value, target),
    rowCount: denom,
    clickThroughHref: `/dashboard/${input.siteCode}/loads?${periodQueryFragments(
      input.periodStart,
      input.periodEnd,
    )}`,
    caption: `${onTime}/${denom} unloaded within ${input.site.dock_sla_minutes} min`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Metric 4 — Recycling rate (CA ≥75%, OR ≥70%)
// ────────────────────────────────────────────────────────────────────────

/**
 * Per COMPLIANCE.md §4:
 *   target calculation = `weight_recycled_lbs / weight_received_lbs`
 *                        over the rolling 12-month period
 *   MVP note         = "display the most recent monthly value pulled
 *                       from MyMRC reconciliation"
 *
 * Schema reality: there is no `weight_recycled` column anywhere in the
 * schema today (it lands with V2.1's Processor Form workflow). The
 * available proxy is `MymrcReconciliationItem.external_weight_lbs` —
 * MyMRC's own row of the same submission corpus, captured during
 * reconciliation upload (T-016). MyMRC's totals aggregate received +
 * recycled per haul, so the percentage of incoming weight that
 * MyMRC has accepted as reconciled is the closest in-MVP signal of
 * "diverted from landfill on the MyMRC side".
 *
 * We compute over the dashboard period rather than the canonical
 * 12-month rolling window because (a) reconciliations are uploaded
 * monthly per the contract, so a per-period view tracks the
 * manager's typical scrutiny window, (b) the COMPLIANCE.md MVP
 * directive is explicit about "most recent monthly value" not the
 * full 12-month rolling. Caption documents the proxy clearly so a
 * manager understands the value is reconciliation-derived, not the
 * canonical landfill-diversion ratio.
 *
 * When V2.1 ships processed-weight tracking + ADR-0011's Processor
 * Form, this metric becomes a drop-in replacement for the proxy
 * with the canonical numerator/denominator.
 */
async function metric4RecyclingRate(input: MetricInput): Promise<MetricResult> {
  const target = Number(input.site.recycling_rate_target_pct);
  const href = `/dashboard/${input.siteCode}/loads?${periodQueryFragments(
    input.periodStart,
    input.periodEnd,
  )}&status=submitted_to_mymrc,processed`;

  // Pull all reconciliation items whose parent reconciliation period
  // intersects the dashboard window. Two-step join because
  // `MymrcReconciliationItem` carries the weight; the parent
  // `MymrcReconciliation` carries the period + site. Lifted in two
  // queries to keep the SQL plain — both reads sit on the existing
  // `(site_id, period_start)` index.
  const recs = await prisma.mymrcReconciliation.findMany({
    where: {
      site_id: input.siteId,
      period_start: { lt: input.periodEnd },
      period_end: { gte: input.periodStart },
    },
    select: { id: true },
  });
  if (recs.length === 0) {
    // No reconciliation has been uploaded for the period. Without
    // proxy data the metric has nothing to grade; render green-with-
    // empty-corpus, mirroring metrics #1 and #2 — caption is the
    // operator-readable truth.
    return {
      value: 0,
      threshold: target,
      unit: '%',
      bucket: 'green',
      rowCount: 0,
      clickThroughHref: href,
      caption: `0 reconciled lbs in scope · MyMRC reconciliation proxy`,
    };
  }

  const items = await prisma.mymrcReconciliationItem.findMany({
    where: { reconciliation_id: { in: recs.map((r) => r.id) } },
    select: {
      external_weight_lbs: true,
      status: true,
    },
  });

  // The "reconciled" subset = matched/resolved (weight on the MyMRC
  // side has been accepted as reconciled with DR3-Vision data). The
  // denominator is the sum across ALL items in the period — the
  // total incoming weight as MyMRC saw it.
  let receivedLbs = 0;
  let reconciledLbs = 0;
  for (const it of items) {
    const w = it.external_weight_lbs ?? 0;
    receivedLbs += w;
    if (it.status === 'resolved') {
      reconciledLbs += w;
    }
    // `unmatched_in_dr3` / `unmatched_in_mymrc` / `count_mismatch` /
    // `weight_mismatch` count toward received but not reconciled.
  }

  if (receivedLbs <= 0) {
    return {
      value: 0,
      threshold: target,
      unit: '%',
      bucket: 'green',
      rowCount: items.length,
      clickThroughHref: href,
      caption: `0 reconciled lbs in scope · MyMRC reconciliation proxy`,
    };
  }

  const value = Math.round((reconciledLbs / receivedLbs) * 1000) / 10;
  return {
    value,
    threshold: target,
    unit: '%',
    bucket: bucketForPctMetric(value, target),
    rowCount: items.length,
    clickThroughHref: href,
    caption: `${reconciledLbs.toLocaleString()}/${receivedLbs.toLocaleString()} lbs reconciled · MyMRC proxy until V2.1`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Metric 5 — In/out weight reconciliation (≥97%)
// ────────────────────────────────────────────────────────────────────────

/**
 * Per COMPLIANCE.md §5: closeness of `weight_in` to
 * (`weight_recycled + weight_waste + weight_inventory`). In MVP the
 * out-side breakdown is V2.1; the closest in-MVP read is the MyMRC
 * reconciliation upload (T-016, also pending). For now we read
 * `mymrc_reconciliations` for the period — if there's a row, we
 * surface the matched/total ratio as a stand-in (a MyMRC-side check
 * of the same submission corpus). If there isn't, we render `pending`.
 *
 * Becomes exact when V2.1 ships processed-weight tracking + T-016
 * lands the reconciliation upload UI.
 */
async function metric5Reconciliation(input: MetricInput): Promise<MetricResult> {
  const target = Number(input.site.reconciliation_target_pct);
  const recs = await prisma.mymrcReconciliation.findMany({
    where: {
      site_id: input.siteId,
      period_start: { lt: input.periodEnd },
      period_end: { gte: input.periodStart },
    },
    select: { matched_count: true, total_rows: true },
  });

  if (recs.length === 0) {
    return {
      value: 0,
      threshold: target,
      unit: '%',
      bucket: 'pending',
      rowCount: 0,
      clickThroughHref: `/dashboard/${input.siteCode}/loads?${periodQueryFragments(
        input.periodStart,
        input.periodEnd,
      )}`,
      caption: 'Pending — no reconciliation uploaded for period',
    };
  }
  const total = recs.reduce((s, r) => s + r.total_rows, 0);
  const matched = recs.reduce((s, r) => s + r.matched_count, 0);
  const value = total === 0 ? 100 : Math.round((matched / total) * 1000) / 10;
  return {
    value,
    threshold: target,
    unit: '%',
    bucket: total === 0 ? 'green' : bucketForPctMetric(value, target),
    rowCount: total,
    clickThroughHref: `/dashboard/${input.siteCode}/loads?${periodQueryFragments(
      input.periodStart,
      input.periodEnd,
    )}`,
    caption: `${matched}/${total} matched in MyMRC`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Metric 6 — Storage inventory vs site limit
// ────────────────────────────────────────────────────────────────────────

/**
 * Per COMPLIANCE.md §6:
 *   - California (Woodland): 3,500 indoor + 5,000 outdoor (separate counters)
 *   - Oregon (Eugene):       6,000 total on-site (off-site prohibited)
 *
 * Schema gap: `site_inventory_snapshots` is the intended data source but
 * no code path writes to it yet (flagged in the previous CHANGELOG as a
 * cross-cutting follow-up). We compute on-demand from `inbound_loads`
 * per the T-012 brief: units arrived ALL-TIME minus units processed
 * gives the live on-site count. (Restricting to the period would
 * undercount — units sitting in inventory from before the period are
 * still on-site today.)
 *
 * Indoor/outdoor split: the schema has no per-load indoor/outdoor flag,
 * so for CA we sum the two limits and grade against total on-site. The
 * snapshot writer (when it lands) will give us the split. Caption notes
 * this caveat.
 */
async function metric6StorageInventory(input: MetricInput): Promise<MetricResult> {
  // Indoor + outdoor for CA, total for OR.
  const capacity =
    (input.site.max_units_total_on_site ?? 0) +
    (input.site.max_units_indoor ?? 0) +
    (input.site.max_units_outdoor ?? 0);

  // Live computed: units that arrived but haven't fallen off the on-site
  // counter. `processed` is the only state that removes a load from
  // inventory (V2.1 will refine this once shipping is tracked).
  const onSiteAgg = await prisma.inboundLoad.aggregate({
    where: {
      site_id: input.siteId,
      arrived_at: { not: null },
      status: {
        in: [
          LoadStatus.arrived,
          LoadStatus.weight_captured,
          LoadStatus.unload_started,
          LoadStatus.in_progress,
          LoadStatus.finished,
          LoadStatus.submitted,
          LoadStatus.verified,
          LoadStatus.submitted_to_mymrc,
        ],
      },
    },
    _sum: { total_units: true },
  });
  const onSite = onSiteAgg._sum.total_units ?? 0;

  if (capacity <= 0) {
    // No site limit configured — render pending so it doesn't grade as
    // a misleading green.
    return {
      value: onSite,
      threshold: 0,
      unit: 'units',
      bucket: 'pending',
      rowCount: 0,
      clickThroughHref: `/dashboard/${input.siteCode}/loads?status=arrived,weight_captured,unload_started,in_progress,finished,submitted,verified,submitted_to_mymrc`,
      caption: 'No site limit configured',
    };
  }

  const pct = (onSite / capacity) * 100;
  const pctRounded = Math.round(pct * 10) / 10;
  return {
    value: onSite,
    threshold: capacity,
    unit: 'units',
    bucket: bucketForCapacity(onSite, capacity),
    rowCount: onSite,
    clickThroughHref: `/dashboard/${input.siteCode}/loads?status=arrived,weight_captured,unload_started,in_progress,finished,submitted,verified,submitted_to_mymrc`,
    caption: `${pctRounded}% of ${capacity.toLocaleString()} unit capacity · live computed (snapshot writer pending)`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Metric 7 — Records retention status
// ────────────────────────────────────────────────────────────────────────

/**
 * Per COMPLIANCE.md §7 + per-site `records_retention_years` (CA 4yr,
 * OR 5yr): every record inside the window must be retrievable, no
 * record past the window should remain un-purged.
 *
 * In early operation this is always green (no record is older than the
 * site is). We surface "years until oldest record reaches the cliff"
 * as the value so managers have a real countdown. Yellow when the
 * oldest record is within 1 year of the cliff; red when at/past cliff
 * (audit-flag territory).
 */
async function metric7RecordsRetention(input: MetricInput): Promise<MetricResult> {
  const years = input.site.records_retention_years;
  const oldest = await prisma.inboundLoad.findFirst({
    where: { site_id: input.siteId, arrived_at: { not: null } },
    select: { arrived_at: true },
    orderBy: { arrived_at: 'asc' },
  });
  if (!oldest?.arrived_at) {
    return {
      value: years,
      threshold: years,
      unit: 'yrs',
      bucket: 'green',
      rowCount: 0,
      clickThroughHref: `/dashboard/${input.siteCode}/loads?range=custom`,
      caption: `No records yet · ${years}-year retention`,
    };
  }
  const ageMs = Date.now() - oldest.arrived_at.getTime();
  const ageYears = ageMs / (365.25 * 24 * 3600 * 1000);
  const remaining = years - ageYears;
  const remainingRounded = Math.round(remaining * 10) / 10;
  return {
    value: remainingRounded,
    threshold: years,
    unit: 'yrs',
    bucket: bucketForRetention(remaining),
    rowCount: 1,
    clickThroughHref: `/dashboard/${input.siteCode}/loads?range=custom`,
    caption: `Oldest record ${Math.round(ageYears * 10) / 10} yr old · ${years}-year window`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Public collector
// ────────────────────────────────────────────────────────────────────────

export interface MetricSlate {
  mymrcSubmission: MetricResult;
  processedUnits: MetricResult;
  dockSla: MetricResult;
  recyclingRate: MetricResult;
  reconciliation: MetricResult;
  storageInventory: MetricResult;
  recordsRetention: MetricResult;
}

/**
 * Collect all seven metrics in parallel. Page-level callers do this
 * once per render — the per-tile reads are independent so `Promise.all`
 * dominates the wall-clock.
 */
export async function collectMetrics(input: MetricInput): Promise<MetricSlate> {
  const [
    mymrcSubmission,
    processedUnits,
    dockSla,
    recyclingRate,
    reconciliation,
    storageInventory,
    recordsRetention,
  ] = await Promise.all([
    metric1MyMrcSubmissionTimeliness(input),
    metric2ProcessedUnitsSubmission(input),
    metric3DockSla(input),
    metric4RecyclingRate(input),
    metric5Reconciliation(input),
    metric6StorageInventory(input),
    metric7RecordsRetention(input),
  ]);
  return {
    mymrcSubmission,
    processedUnits,
    dockSla,
    recyclingRate,
    reconciliation,
    storageInventory,
    recordsRetention,
  };
}
