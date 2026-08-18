// ADR-0108 — "this load's weight is unusual for this commodity; look at it".
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THIS IS A LOOK-AT-THIS, NOT A VERDICT.                                    │
// │                                                                           │
// │ A flag here says one thing: this weight is far from what this commodity   │
// │ usually weighs, against a line an admin can move. It does NOT say the     │
// │ figure is wrong, disputed, or a mismatch, because nothing in this system  │
// │ knows that. What a disagreement MEANS is AK-4c and it belongs to Bill     │
// │ with Rick and Janette. There is no alert channel and no email on this     │
// │ path — a flag is something a person finds when they go and look.          │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── The comparand this module was ASKED for does not exist ─────────────────
// Handoff #264 asked for expected-vs-actual weight variance. Measured against
// prod 2026-08-18 before writing any code:
//
//   - `mymrc_outbound_mirror.weight_lbs` is NULL on 4,685 of 4,685 rows;
//   - its payload holds no weight-like key anywhere — `payload::text ILIKE
//     '%weight%'` matches 0 rows;
//   - positive unit counts exist on 1 of the 831 joined loads, so there is no
//     lbs-per-unit denominator to derive one from;
//   - and the workbook's own total-vs-parts is 0-drift on 831 of 831, already
//     reconciled at absorption.
//
// There is no expected-vs-actual pair. Building one anyway would mean inventing
// the expected side, and a guess made first becomes the default by inertia
// (ADR-0080 §D7). So this module does the weaker, honest thing instead: it
// compares a load against the OTHER LOADS OF THE SAME COMMODITY, which is a
// comparison the data actually supports.
//
// (One near-miss worth knowing about: 39 mirror rows DO carry per-commodity
// pound figures under Salesforce commodity keys — `Waste__c`, `Wood__c`. They
// are all March 2024, and their overlap with the workbook's Jan–Jun 2026 loads
// is ZERO. If detail capture were ever extended to the workbook's range, a real
// expected-vs-actual pair would exist and this module should be revisited.)
//
// ── Why the deviation is measured in LOG space ─────────────────────────────
// See the migration and the ADR. Short version: weights are strictly positive,
// so a symmetric ±k×MAD bound in pounds is structurally blind on the low side —
// Wood's low side caps at 4.01 MAD, so no k ≥ 4.01 can ever flag a low Wood
// weight, including the `Wood 40 lb` row this exists to surface.
//
// READ-ONLY. This module opens no write path of any kind.

import { prisma } from '@/lib/prisma';
import type { OutboundScope } from './outbound-reconcile';

/** Why a commodity is not being bounded. `null` means it is. */
export type BoundInactiveReason = 'turned_off' | 'too_few_observations' | 'no_spread';

export interface OutboundVarianceBound {
  /** VERBATIM workbook stem. */
  commodity: string;
  /** Geometric median, in pounds. */
  medianLbs: number;
  /** One MAD step as a multiplier. */
  spreadRatio: number;
  /** How many steps out the line sits. */
  k: number;
  /** `median / ratio^k`. NULL when this commodity is not bounded. */
  lowLbs: number | null;
  /** `median * ratio^k`. NULL when this commodity is not bounded. */
  highLbs: number | null;
  /** How many observations the seeded figures were measured from. */
  sampleN: number;
  minSampleN: number;
  /** `null` when the bound is live. */
  inactiveReason: BoundInactiveReason | null;
}

export interface OutboundVarianceFlag {
  externalMaterialsId: string;
  commodity: string;
  weightLbs: number;
  lowLbs: number;
  highLbs: number;
  /** Which side of the band. Not a judgement about which is worse. */
  direction: 'above' | 'below';
  /** Distance from the median in MAD steps. Sort order, nothing more. */
  stepsOut: number;
}

export interface OutboundVarianceReview {
  /**
   * The ONE revision every flag came from.
   *
   * Required, not optional, and not defaulted. A flag computed across two
   * revisions would be reporting a superseded number as a live one, and the
   * caller — never this module — is the thing that knows which revision won.
   */
  versionId: string;
  scope: OutboundScope;
  bounds: OutboundVarianceBound[];
  flags: OutboundVarianceFlag[];
  /** Distinct loads with at least one flagged commodity row. */
  flaggedLoadIds: string[];
  /** Commodities present in the rows that have no config row at all. */
  commoditiesWithoutABound: string[];
  /** True when no commodity at this site has a live bound. */
  nothingIsBounded: boolean;
}

/**
 * Resolve the band for one config row.
 *
 * Three separate ways a commodity ends up unbounded, kept distinct because they
 * mean different things to whoever reads the screen: somebody turned it off, or
 * there are too few loads to say what normal is, or every load weighs the same
 * so there is no spread to measure against.
 */
export function resolveBound(row: {
  commodity: string;
  enabled: boolean;
  median_lbs: number;
  spread_ratio: number;
  k: number;
  min_sample_n: number;
  sample_n: number;
}): OutboundVarianceBound {
  const base = {
    commodity: row.commodity,
    medianLbs: row.median_lbs,
    spreadRatio: row.spread_ratio,
    k: row.k,
    sampleN: row.sample_n,
    minSampleN: row.min_sample_n,
  };

  const inactiveReason: BoundInactiveReason | null = !row.enabled
    ? 'turned_off'
    : row.sample_n < row.min_sample_n
      ? 'too_few_observations'
      : // A ratio of exactly 1 is a zero-width band. Flagging on it would flag
        // every row that is not precisely the median — the singleton commodities
        // are all in this state, which is why the check is not merely defensive.
        row.spread_ratio <= 1 || row.median_lbs <= 0 || row.k <= 0
        ? 'no_spread'
        : null;

  if (inactiveReason !== null) {
    return { ...base, lowLbs: null, highLbs: null, inactiveReason };
  }

  const span = Math.pow(row.spread_ratio, row.k);
  return {
    ...base,
    lowLbs: row.median_lbs / span,
    highLbs: row.median_lbs * span,
    inactiveReason: null,
  };
}

export interface OutboundVarianceOptions {
  /**
   * The winning revision. REQUIRED — see {@link OutboundVarianceReview.versionId}.
   */
  versionId: string;
  /**
   * Which absorption state the caller is rendering. Carried through so flags
   * describe the SAME rows the surface is showing; a staged flag stays staged
   * and is never promoted by being looked at.
   */
  scope: OutboundScope;
}

/**
 * Flag commodity rows that sit outside their commodity's editable band.
 *
 * Only rows INSIDE `versionId` are read, and only rows carrying a weight ABOVE
 * ZERO are considered. A recorded 0 is the workbook stating "this load carried
 * none of this commodity" — flagging it as a low outlier would be flagging a
 * fact, and it is also why the band is computed over non-zero rows only.
 */
export async function computeOutboundVariance(
  siteId: string,
  options: OutboundVarianceOptions,
): Promise<OutboundVarianceReview> {
  const { versionId, scope } = options;

  const [configRows, commodityRows] = await Promise.all([
    prisma.outboundVarianceConfig.findMany({
      where: { site_id: siteId },
      orderBy: { commodity: 'asc' },
    }),
    prisma.docOutboundCommodityRow.findMany({
      // SITE, SCOPE, and ONE VERSION ONLY. Dropping the version clause makes a
      // superseded revision's rows flaggable; a test falsifies it.
      where: { site_id: siteId, status: scope, doc_source_version_id: versionId },
      select: { external_materials_id: true, commodity: true, weight_lbs: true },
    }),
  ]);

  const bounds = configRows.map((r) =>
    resolveBound({
      commodity: r.commodity,
      enabled: r.enabled,
      median_lbs: Number(r.median_lbs),
      spread_ratio: Number(r.spread_ratio),
      k: Number(r.k),
      min_sample_n: r.min_sample_n,
      sample_n: r.sample_n,
    }),
  );
  const byCommodity = new Map(bounds.map((b) => [b.commodity, b]));

  const flags: OutboundVarianceFlag[] = [];
  const seenCommodities = new Set<string>();
  const withoutABound = new Set<string>();

  for (const row of commodityRows) {
    seenCommodities.add(row.commodity);
    const bound = byCommodity.get(row.commodity);
    if (bound === undefined) {
      // No line has been set for this commodity. Stated, never treated as
      // "within bounds" — an absent rule is not a passing grade.
      withoutABound.add(row.commodity);
      continue;
    }
    if (bound.inactiveReason !== null || bound.lowLbs === null || bound.highLbs === null) continue;

    const weight = row.weight_lbs === null ? null : Number(row.weight_lbs);
    if (weight === null || weight <= 0) continue;
    if (weight >= bound.lowLbs && weight <= bound.highLbs) continue;

    flags.push({
      externalMaterialsId: row.external_materials_id,
      commodity: row.commodity,
      weightLbs: weight,
      lowLbs: bound.lowLbs,
      highLbs: bound.highLbs,
      direction: weight > bound.highLbs ? 'above' : 'below',
      stepsOut:
        Math.abs(Math.log(weight) - Math.log(bound.medianLbs)) / Math.log(bound.spreadRatio),
    });
  }

  flags.sort((a, b) => b.stepsOut - a.stepsOut);

  return {
    versionId,
    scope,
    bounds,
    flags,
    flaggedLoadIds: [...new Set(flags.map((f) => f.externalMaterialsId))].sort(),
    commoditiesWithoutABound: [...withoutABound].sort(),
    nothingIsBounded: bounds.every((b) => b.inactiveReason !== null),
  };
}

/** The bound rows for one site, for the editing surface. */
export async function listVarianceBounds(
  siteId: string,
): Promise<
  (OutboundVarianceBound & { id: string; enabled: boolean; seedMeasuredOnISO: string | null })[]
> {
  const rows = await prisma.outboundVarianceConfig.findMany({
    where: { site_id: siteId },
    orderBy: [{ sample_n: 'desc' }, { commodity: 'asc' }],
  });
  return rows.map((r) => ({
    ...resolveBound({
      commodity: r.commodity,
      enabled: r.enabled,
      median_lbs: Number(r.median_lbs),
      spread_ratio: Number(r.spread_ratio),
      k: Number(r.k),
      min_sample_n: r.min_sample_n,
      sample_n: r.sample_n,
    }),
    id: r.id,
    enabled: r.enabled,
    seedMeasuredOnISO: r.seed_measured_on === null ? null : r.seed_measured_on.toISOString(),
  }));
}
