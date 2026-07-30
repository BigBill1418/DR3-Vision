// ADR-0069 — the RECONCILIATION: spreadsheet figure vs. Vision figure, per day.
//
// This is the instrument the migration was missing. Bill's framing was that the
// colleagues' documents should be "absorbed into the system as a reference point
// until Vision is able to take this over completely" — and "until Vision takes
// over" is a claim nobody could evaluate, because nothing compared the two. When a
// site's deltas are persistently zero, that site's spreadsheet is retirable. When
// they are not, the discrepancy is the operational finding, which is what the
// workbooks are actually for.
//
// ── Computed at READ time, deliberately not stored ─────────────────────────
// A persisted reconciliation would be a THIRD thing to keep in sync, and it would
// go stale the moment `processed_units_daily` changed underneath it — which it
// does, from the MyMRC bridges and from operator entry. A stale agreement is worse
// than no agreement: it is a green light with nothing behind it, which is the exact
// failure class this module keeps re-learning. Reading both sides live costs two
// indexed queries and can never be wrong about the present.
//
// ── Only the CURRENT revision of a document contributes ────────────────────
// Superseded revisions keep their reference rows as history (they are the evidence
// of what the spreadsheet said at the time), but a document speaks with one voice
// per comparison: the latest APPLIED revision. Summing across revisions would count
// the same day several times over.
//
// ── The coverage window, and why "missing" is bounded by it ────────────────
// A Vision day with no reference row is only a FINDING when the spreadsheet
// actually covers that period. `processed_units_daily` holds years of MyMRC-derived
// history; a July workbook says nothing about 2023, and reporting 900 days as
// "missing from the spreadsheet" would bury the handful of real discrepancies.
//
// Coverage is tracked per (site, METRIC), not per site, and that distinction is
// load-bearing rather than fussy. `stripped_non_program` carries `@default(0)` in
// `processed_units_daily`, so a Vision row has a zero there whether or not anyone
// entered one. If a workbook states program units but never non-program units, a
// site-level window would report EVERY covered day as "missing a non-program
// figure" — reintroducing exactly the noise the window exists to remove, one level
// down. A metric the spreadsheet never speaks about is simply not covered.
//
// Outside the window the honest answer is "not covered", and the summary reports
// the span so that is legible rather than implied.

import type { PrismaClient, Prisma, DocReferenceMetric } from '@prisma/client';
import { dayISO } from '@/lib/time';

export type ReconciliationStatus =
  /** Both sides have a figure and they are identical. */
  | 'agree'
  /** Both sides have a figure and they differ. */
  | 'disagree'
  /** The spreadsheet states a figure; Vision has no row for that day. */
  | 'missing_in_vision'
  /** Vision has a row inside the covered period; the spreadsheet states nothing. */
  | 'missing_in_reference';

export const RECONCILIATION_METRICS: readonly DocReferenceMetric[] = [
  'stripped_program',
  'stripped_non_program',
  'saved_units',
] as const;

export interface ReconciliationRow {
  siteId: string;
  siteName: string;
  /** 'YYYY-MM-DD'. A production day is a day — never rendered from an instant. */
  productionDate: string;
  metric: DocReferenceMetric;
  referenceValue: number | null;
  visionValue: number | null;
  /** reference − vision. Null when either side is absent. */
  delta: number | null;
  status: ReconciliationStatus;
  /** Provenance, so a disagreement can be chased to the document it came from. */
  documentName: string | null;
  docSourceId: string | null;
  docSourceVersionId: string | null;
}

export interface ReconciliationSiteSummary {
  siteId: string;
  siteName: string;
  agree: number;
  disagree: number;
  missingInVision: number;
  missingInReference: number;
  /** Sum of |delta| over comparable rows — one number for "how far apart are we". */
  totalAbsDelta: number;
  /** Distinct days the spreadsheet covers in this window. */
  daysCovered: number;
  /** First/last day the spreadsheet speaks about, or null when it covers nothing. */
  coverageFrom: string | null;
  coverageTo: string | null;
  /** Contributing documents, for the "where did this come from" line. */
  documents: string[];
}

export interface ReconciliationResult {
  rows: ReconciliationRow[];
  summaries: ReconciliationSiteSummary[];
  /** Echo of the requested window, so a screen never has to re-derive it. */
  from: string;
  to: string;
}

export interface ReconcileArgs {
  db: PrismaClient;
  /** Sites the CALLER may see. Resolved server-side from their reach, never sent by a client. */
  siteIds: string[];
  /** Inclusive 'YYYY-MM-DD' bounds. */
  from: string;
  to: string;
}

/**
 * Compare every reference figure against Vision's own for the given sites/window.
 *
 * Returns rows ordered newest-day-first, then by metric — the order an operator
 * reads them in, so no screen has to re-sort.
 */
export async function reconcileReference(args: ReconcileArgs): Promise<ReconciliationResult> {
  const { db, siteIds, from, to } = args;
  const empty: ReconciliationResult = { rows: [], summaries: [], from, to };
  if (siteIds.length === 0) return empty;

  const fromKey = new Date(`${from}T00:00:00.000Z`);
  const toKey = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromKey.getTime()) || Number.isNaN(toKey.getTime())) return empty;

  const sites = await db.site.findMany({
    where: { id: { in: siteIds } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  // ── The current revision per document ────────────────────────────────────
  // One voice per document (see the header note). Resolved first so the reference
  // read can filter to it rather than de-duplicating afterwards.
  const applied = await db.docSourceVersion.findMany({
    where: {
      applied_at: { not: null },
      absorption_status: 'absorbed',
      doc_source: { site_id: { in: siteIds } },
    },
    select: {
      id: true,
      doc_source_id: true,
      applied_at: true,
      doc_source: { select: { display_name: true } },
    },
    orderBy: { applied_at: 'desc' },
  });

  const currentVersionBySource = new Map<string, { id: string; documentName: string }>();
  for (const v of applied) {
    // `applied` is sorted newest-first, so the FIRST row seen for a source is its
    // current revision.
    if (!currentVersionBySource.has(v.doc_source_id)) {
      currentVersionBySource.set(v.doc_source_id, {
        id: v.id,
        documentName: v.doc_source.display_name,
      });
    }
  }
  const currentVersionIds = [...currentVersionBySource.values()].map((v) => v.id);
  if (currentVersionIds.length === 0) return { ...empty, summaries: baseSummaries(sites) };

  const referenceRows = await db.docReferenceRow.findMany({
    where: {
      site_id: { in: siteIds },
      doc_source_version_id: { in: currentVersionIds },
      production_date: { gte: fromKey, lte: toKey },
    },
    select: {
      site_id: true,
      production_date: true,
      metric: true,
      value: true,
      doc_source_id: true,
      doc_source_version_id: true,
    },
  });

  const visionRows = await db.processedUnitsDaily.findMany({
    where: { site_id: { in: siteIds }, production_date: { gte: fromKey, lte: toKey } },
    select: {
      site_id: true,
      production_date: true,
      stripped_program: true,
      stripped_non_program: true,
      saved_units: true,
    },
  });

  const visionByKey = new Map<string, (typeof visionRows)[number]>();
  for (const v of visionRows) visionByKey.set(`${v.site_id}|${dayISO(v.production_date)}`, v);

  // Coverage per (site, metric) — the span the spreadsheet speaks about for THAT
  // figure. See the header note on why this is not per-site.
  const metricCoverage = new Map<string, { first: string; last: string }>();
  // Coverage per site — the union, for the summary line only.
  const coverage = new Map<string, { first: string; last: string; days: Set<string> }>();
  for (const r of referenceRows) {
    const day = dayISO(r.production_date);

    const mKey = `${r.site_id}|${r.metric}`;
    const m = metricCoverage.get(mKey);
    if (!m) metricCoverage.set(mKey, { first: day, last: day });
    else {
      if (day < m.first) m.first = day;
      if (day > m.last) m.last = day;
    }

    const c = coverage.get(r.site_id);
    if (!c) {
      coverage.set(r.site_id, { first: day, last: day, days: new Set([day]) });
      continue;
    }
    if (day < c.first) c.first = day;
    if (day > c.last) c.last = day;
    c.days.add(day);
  }

  const rows: ReconciliationRow[] = [];
  const seen = new Set<string>();

  // ── Pass 1: every reference figure, compared. ────────────────────────────
  for (const r of referenceRows) {
    const day = dayISO(r.production_date);
    const vision = visionByKey.get(`${r.site_id}|${day}`);
    const referenceValue = decToNumber(r.value);
    const visionValue = vision ? visionMetric(vision, r.metric) : null;
    const current = currentVersionBySource.get(r.doc_source_id);
    seen.add(`${r.site_id}|${day}|${r.metric}`);

    rows.push({
      siteId: r.site_id,
      siteName: siteName.get(r.site_id) ?? r.site_id,
      productionDate: day,
      metric: r.metric,
      referenceValue,
      visionValue,
      delta: visionValue === null ? null : round2(referenceValue - visionValue),
      status:
        visionValue === null
          ? 'missing_in_vision'
          : round2(referenceValue - visionValue) === 0
            ? 'agree'
            : 'disagree',
      documentName: current?.documentName ?? null,
      docSourceId: r.doc_source_id,
      docSourceVersionId: r.doc_source_version_id,
    });
  }

  // ── Pass 2: Vision days INSIDE the covered window that the spreadsheet ────
  // does not mention. Bounded by coverage on purpose — see the header note.
  for (const v of visionRows) {
    const day = dayISO(v.production_date);
    for (const metric of RECONCILIATION_METRICS) {
      if (seen.has(`${v.site_id}|${day}|${metric}`)) continue;
      // Bounded by THIS metric's window. A metric the spreadsheet never states is
      // not covered at all, so its absence is not a finding.
      const m = metricCoverage.get(`${v.site_id}|${metric}`);
      if (!m || day < m.first || day > m.last) continue;
      const visionValue = visionMetric(v, metric);
      // Vision itself has nothing to say either (a null `saved_units` is an
      // absence on both sides, not a discrepancy).
      if (visionValue === null) continue;
      rows.push({
        siteId: v.site_id,
        siteName: siteName.get(v.site_id) ?? v.site_id,
        productionDate: day,
        metric,
        referenceValue: null,
        visionValue,
        delta: null,
        status: 'missing_in_reference',
        documentName: null,
        docSourceId: null,
        docSourceVersionId: null,
      });
    }
  }

  rows.sort(
    (a, b) =>
      b.productionDate.localeCompare(a.productionDate) ||
      a.siteName.localeCompare(b.siteName) ||
      a.metric.localeCompare(b.metric),
  );

  return { rows, summaries: summarize(sites, rows, coverage), from, to };
}

function baseSummaries(sites: Array<{ id: string; name: string }>): ReconciliationSiteSummary[] {
  return sites.map((s) => ({
    siteId: s.id,
    siteName: s.name,
    agree: 0,
    disagree: 0,
    missingInVision: 0,
    missingInReference: 0,
    totalAbsDelta: 0,
    daysCovered: 0,
    coverageFrom: null,
    coverageTo: null,
    documents: [],
  }));
}

function summarize(
  sites: Array<{ id: string; name: string }>,
  rows: ReconciliationRow[],
  coverage: Map<string, { first: string; last: string; days: Set<string> }>,
): ReconciliationSiteSummary[] {
  const bySite = new Map<string, ReconciliationSiteSummary>();
  for (const s of baseSummaries(sites)) bySite.set(s.siteId, s);

  const docsBySite = new Map<string, Set<string>>();
  for (const row of rows) {
    const s = bySite.get(row.siteId);
    if (!s) continue;
    if (row.status === 'agree') s.agree += 1;
    else if (row.status === 'disagree') s.disagree += 1;
    else if (row.status === 'missing_in_vision') s.missingInVision += 1;
    else s.missingInReference += 1;
    if (row.delta !== null) s.totalAbsDelta = round2(s.totalAbsDelta + Math.abs(row.delta));
    if (row.documentName) {
      const set = docsBySite.get(row.siteId) ?? new Set<string>();
      set.add(row.documentName);
      docsBySite.set(row.siteId, set);
    }
  }

  for (const [siteId, s] of bySite) {
    const c = coverage.get(siteId);
    if (c) {
      s.coverageFrom = c.first;
      s.coverageTo = c.last;
      s.daysCovered = c.days.size;
    }
    s.documents = [...(docsBySite.get(siteId) ?? new Set<string>())].sort();
  }

  return [...bySite.values()];
}

function visionMetric(
  row: {
    stripped_program: Prisma.Decimal;
    stripped_non_program: Prisma.Decimal;
    saved_units: Prisma.Decimal | null;
  },
  metric: DocReferenceMetric,
): number | null {
  switch (metric) {
    case 'stripped_program':
      return decToNumber(row.stripped_program);
    case 'stripped_non_program':
      return decToNumber(row.stripped_non_program);
    case 'saved_units':
      return row.saved_units === null ? null : decToNumber(row.saved_units);
  }
}

function decToNumber(d: Prisma.Decimal): number {
  return round2(Number(d.toString()));
}

/**
 * Two decimals, matching the reference column's scale.
 *
 * Comparison is EXACT at that scale — there is deliberately no tolerance band. A
 * half-unit difference between the paper record and Vision is a real difference,
 * and a tolerance would be a threshold nobody chose that quietly reclassifies real
 * discrepancies as agreement.
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
