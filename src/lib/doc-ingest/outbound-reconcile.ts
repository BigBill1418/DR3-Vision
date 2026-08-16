// ADR-0104 §D10 — the outbound coverage read.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THIS MODULE SURFACES THE JOIN. IT DOES NOT GRADE IT.                      │
// │                                                                           │
// │ There is no threshold, no tolerance, no `ok`/`mismatch` verdict and no    │
// │ alert anywhere in this file, and that is a DECISION rather than an        │
// │ omission. Whether a disagreement between the mirror and the workbook is a │
// │ problem, and at what size, is AK-4c                                       │
// │ (`docs/plans/2026-08-08-layer-b-commodity-reconciliation-rescope.md`) and │
// │ it belongs to Bill with Rick and Janette. Encoding a guess now would make │
// │ the guess authoritative by being first, which is exactly how the          │
// │ commodity tracker acquired a shape nobody had agreed to (ADR-0080 §D7).   │
// │                                                                           │
// │ It is registered as P-48 so the absence is on the record and not          │
// │ rediscovered later as an oversight somebody "fixes" by guessing.          │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── THE VERSION PIN — the whole reason this is not a `findMany` ────────────
// Read `latestVersion` in `commodity-ledger.ts` and `latestConfirmedVersionId`
// in `src/lib/equipment/terex-ledger.ts` first. They record the 2026-08-06
// incident: registering TEREX.xlsx made all THREE applied revisions absorbable
// at once, the backlog sweep took all three, and the site-wide sum reported
// exactly 3x the truth. Each per-version total was PERFECT; summing ACROSS
// versions is what was wrong.
//
// The trap is live here and this is the first table whose figures will be summed
// against an EXTERNAL record — which is precisely the situation in which a
// plausible-looking wrong total survives review. The unique key is
// `(version, external_materials_id)`, so two confirmed revisions of one workbook
// coexist, each carrying a complete 831-load copy, and an unpinned read would
// report 1,662 weighed loads against 834 mirror loads. So: pin the winning
// revision FIRST, then aggregate only inside it. This must not DEPEND on
// superseded batches having been discarded — a total that is only correct when
// somebody remembered to tidy up is not a guarantee.
//
// ── The honest headline is a BAD one, and that is the point ────────────────
// The workbook covers Woodland, January to June 2026. `mymrc_outbound_mirror`
// holds 4,673 loads from 2023-01-02 to 2026-08-14. So the first honest readout
// will say that roughly 3,840 loads still have no weight — worse-looking than
// today's silence, and true. That is P-47.
//
// READ-ONLY. This module opens no write path of any kind.

import { prisma } from '@/lib/prisma';

/**
 * Which absorption state to read.
 *
 * NEVER a union of the two. Staged rows are an extraction nobody has accepted;
 * mixing them into a confirmed total would present a proposal as a fact — and
 * because both states can carry a complete copy of the workbook, mixing them
 * ALSO double-counts.
 */
export type OutboundScope = 'confirmed' | 'staged';

/** The bucket for loads whose shipment date the mirror does not state. */
export const UNDATED_BUCKET = 'undated';

export interface OutboundMonthCoverage {
  /** `YYYY-MM`, or {@link UNDATED_BUCKET}. */
  month: string;
  /** Loads the MIRROR holds for this site and month. The denominator. */
  mirrorLoads: number;
  /** Of those, how many the pinned revision supplies a weight for. */
  loadsWithWeight: number;
  /** Of those, how many it does not. Stated plainly, never hidden. */
  loadsWithoutWeight: number;
  /** Summed `total_weight_lbs` over `loadsWithWeight`. */
  weightLbs: number;
}

export interface OutboundCommodityCoverage {
  /** VERBATIM stem as the workbook wrote it. */
  commodity: string;
  rows: number;
  weightLbs: number;
}

export interface OutboundCoverage {
  scope: OutboundScope;
  /** The ONE revision every figure came from. NULL when the site has none. */
  versionId: string | null;
  absorbedAtISO: string | null;
  months: OutboundMonthCoverage[];
  totals: {
    mirrorLoads: number;
    loadsWithWeight: number;
    loadsWithoutWeight: number;
    weightLbs: number;
  };
  commodities: OutboundCommodityCoverage[];
  /**
   * Absorbed loads whose Materials ID has NO row in the mirror.
   *
   * A weight for a shipment the system has no record of is a finding, not a
   * rounding error, and it would be invisible in a coverage percentage — which
   * only ever counts the mirror's side. Measured 0 of 831 against prod on
   * 2026-08-16; it is surfaced so that stops being an assumption.
   */
  unmatchedAbsorbedLoads: string[];
  /**
   * Materials IDs that appeared MORE THAN ONCE in the rows read.
   *
   * ── This field is the version pin's own alarm ──────────────────────────
   * `(doc_source_version_id, external_materials_id)` is UNIQUE, so inside one
   * revision this is unreachable — it can only be non-zero if the version
   * clause was dropped and a second revision's complete copy is in scope.
   *
   * It exists because the obvious symptom does NOT occur. Coverage is computed
   * through a `Map` keyed on the Materials ID, and a map silently collapses the
   * duplicate: an unpinned read does not double the count, it quietly answers
   * from whichever revision happened to be read last. That is worse than a
   * doubled total, because a doubled total is visibly absurd and an arbitrary
   * one is not. Removing the version clause has to CHANGE AN OBSERVABLE, and
   * this is the observable.
   */
  revisionBleedIds: string[];
  /** True when the requested scope holds nothing, so a surface can say so. */
  awaiting: boolean;
}

function emptyCoverage(scope: OutboundScope): OutboundCoverage {
  return {
    scope,
    versionId: null,
    absorbedAtISO: null,
    months: [],
    totals: { mirrorLoads: 0, loadsWithWeight: 0, loadsWithoutWeight: 0, weightLbs: 0 },
    commodities: [],
    unmatchedAbsorbedLoads: [],
    revisionBleedIds: [],
    awaiting: true,
  };
}

/**
 * The `YYYY-MM` bucket for a timestamp.
 *
 * UTC, deliberately and consistently on both sides. `doc_outbound_load_rows`
 * stores a `DATE` (read back at 00:00 UTC) and `mymrc_outbound_mirror` stores
 * its shipment dates at 12:00 UTC, so a UTC reading gives the calendar day the
 * portal recorded for both. Casting either in a session zone would move loads
 * shipped near a month boundary into the wrong month on one side only — and a
 * month whose denominator and numerator disagree about which loads it contains
 * is worse than no month at all.
 */
export function monthKey(d: Date | null): string {
  return d === null ? UNDATED_BUCKET : d.toISOString().slice(0, 7);
}

/**
 * The revision whose rows ARE this document right now, for one scope.
 *
 * Newest `absorbed_at` wins, because a revision SUPERSEDES its predecessor
 * rather than adding to it. Mirrors `latestVersion` in `commodity-ledger.ts`
 * down to the ordering clause: the bug it exists to stop is identical, and a
 * reader comparing the two should see the same shape rather than a second
 * invention.
 */
async function latestVersion(
  siteId: string,
  scope: OutboundScope,
): Promise<{ versionId: string; absorbedAt: Date } | null> {
  const newest = await prisma.docOutboundLoadRow.findFirst({
    where: { site_id: siteId, status: scope },
    orderBy: { absorbed_at: 'desc' },
    select: { doc_source_version_id: true, absorbed_at: true },
  });
  return newest
    ? { versionId: newest.doc_source_version_id, absorbedAt: newest.absorbed_at }
    : null;
}

export interface OutboundCoverageOptions {
  /** Defaults to `confirmed`. Staged rows are a proposal, never a total. */
  scope?: OutboundScope;
}

/**
 * Outbound weight coverage for one site, from ONE revision of the workbook.
 *
 * The version pin happens before any aggregation and is not optional. Callers
 * get `versionId` back so a surface can state WHICH revision it is showing
 * rather than implying it is showing all of them.
 */
export async function computeOutboundCoverage(
  siteId: string,
  options: OutboundCoverageOptions = {},
): Promise<OutboundCoverage> {
  const scope = options.scope ?? 'confirmed';
  const pinned = await latestVersion(siteId, scope);
  if (pinned === null) return emptyCoverage(scope);

  const [absorbed, mirror, commodityRows] = await Promise.all([
    prisma.docOutboundLoadRow.findMany({
      // SITE (hard rule #2), SCOPE, and ONE VERSION ONLY. Dropping the version
      // clause is the doubled-total defect; a test falsifies it.
      where: { site_id: siteId, status: scope, doc_source_version_id: pinned.versionId },
      select: { external_materials_id: true, total_weight_lbs: true },
    }),
    prisma.mymrcOutboundMirror.findMany({
      where: { site_id: siteId, external_materials_id: { not: null } },
      select: { external_materials_id: true, shipment_date: true },
    }),
    prisma.docOutboundCommodityRow.groupBy({
      by: ['commodity'],
      where: { site_id: siteId, status: scope, doc_source_version_id: pinned.versionId },
      _count: { _all: true },
      _sum: { weight_lbs: true },
    }),
  ]);

  const weightById = new Map<string, number | null>();
  const revisionBleed = new Set<string>();
  for (const a of absorbed) {
    // See `revisionBleedIds`. The check is BEFORE the `set`, because the `set`
    // is what would otherwise hide it.
    if (weightById.has(a.external_materials_id)) revisionBleed.add(a.external_materials_id);
    weightById.set(
      a.external_materials_id,
      a.total_weight_lbs === null ? null : Number(a.total_weight_lbs),
    );
  }

  const buckets = new Map<string, OutboundMonthCoverage>();
  const matched = new Set<string>();
  for (const m of mirror) {
    const id = m.external_materials_id;
    if (id === null) continue;
    const key = monthKey(m.shipment_date);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        month: key,
        mirrorLoads: 0,
        loadsWithWeight: 0,
        loadsWithoutWeight: 0,
        weightLbs: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.mirrorLoads += 1;
    const weight = weightById.get(id);
    if (weight === undefined) {
      bucket.loadsWithoutWeight += 1;
      continue;
    }
    matched.add(id);
    // An absorbed row whose own weight cell was blank is MATCHED but still
    // WITHOUT a weight. Counting it as covered would report a figure the
    // workbook does not actually supply.
    if (weight === null) {
      bucket.loadsWithoutWeight += 1;
      continue;
    }
    bucket.loadsWithWeight += 1;
    bucket.weightLbs += weight;
  }

  const months = [...buckets.values()].sort((a, b) => {
    if (a.month === UNDATED_BUCKET) return 1;
    if (b.month === UNDATED_BUCKET) return -1;
    return b.month.localeCompare(a.month);
  });

  const totals = months.reduce(
    (acc, m) => ({
      mirrorLoads: acc.mirrorLoads + m.mirrorLoads,
      loadsWithWeight: acc.loadsWithWeight + m.loadsWithWeight,
      loadsWithoutWeight: acc.loadsWithoutWeight + m.loadsWithoutWeight,
      weightLbs: acc.weightLbs + m.weightLbs,
    }),
    { mirrorLoads: 0, loadsWithWeight: 0, loadsWithoutWeight: 0, weightLbs: 0 },
  );

  return {
    scope,
    versionId: pinned.versionId,
    absorbedAtISO: pinned.absorbedAt.toISOString(),
    months,
    totals,
    commodities: commodityRows
      .map((c) => ({
        commodity: c.commodity,
        rows: c._count._all,
        weightLbs: Number(c._sum.weight_lbs ?? 0),
      }))
      .sort((a, b) => b.weightLbs - a.weightLbs),
    unmatchedAbsorbedLoads: [...weightById.keys()].filter((id) => !matched.has(id)).sort(),
    revisionBleedIds: [...revisionBleed].sort(),
    awaiting: absorbed.length === 0,
  };
}

/** Sites with any absorbed outbound rows — the surface's site list. */
export async function sitesWithOutboundCoverage(): Promise<{ id: string; name: string }[]> {
  return prisma.site.findMany({
    where: { doc_outbound_load_rows: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
