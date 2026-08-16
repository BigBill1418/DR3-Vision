// ADR-0067 §3.4 — the health read model behind /admin/doc-ingest/health.
//
// The question this surface answers is not "is anything broken right now" — the
// anomaly ledger answers that. It is the harder one: **is the thing that is
// supposed to be watching actually watching?**
//
// Which is why the headline number is SWEEP FRESHNESS, not subscription count.
// A fleet of healthy-looking subscriptions with a dead sweep is the exact state
// MyMRC was in for months (ADR-0057 D9). A dead subscription with a fresh sweep
// is merely slower.

import type { PrismaClient } from '@prisma/client';
import {
  DOC_INGEST_SWEEP_STALE_MS,
  SHARED_WITH_ME_SUNSET,
  SHARED_WITH_ME_SUNSET_IS_INFERRED,
  sharedWithMeDaysRemaining,
} from './pipeline-config';
import { latestReachabilityScan, type ReachabilityGapItem } from './reachability';
import { findSingleInstanceViolations } from './single-instance';

export interface SubscriptionHealth {
  id: string;
  driveId: string;
  state: string;
  expiresAtISO: string | null;
  lastRenewedISO: string | null;
  lastNotificationISO: string | null;
  notificationsReceived: number;
  /** True once Graph's validation handshake has demonstrably succeeded (§A.9). */
  validated: boolean;
  lastError: string | null;
}

export interface DocIngestHealth {
  sweep: {
    lastRunISO: string | null;
    lastSuccessISO: string | null;
    lastStatus: string | null;
    lastTrigger: string | null;
    lastError: string | null;
    /** THE headline. True ⇒ the correctness path has stopped running. */
    stale: boolean;
    staleThresholdHours: number;
    consecutiveFailures: number;
  };
  subscriptions: SubscriptionHealth[];
  /**
   * Push is UNPROVEN when no subscription has ever received a notification.
   * Deliberately distinguished from "broken": before the first change to any
   * watched document there is nothing to have received, so this reads as
   * "not demonstrated yet" rather than as a fault.
   */
  pushProven: boolean;
  sources: {
    total: number;
    active: number;
    disabled: number;
    accessDenied: number;
    disappeared: number;
    readBlocked: number;
    awaitingConfirmation: number;
  };
  anomalies: { open: number; critical: number; acknowledged: number };
  staged: { count: number; oldestISO: string | null };
  /** ⚠ The deprecated `sharedWithMe` enumeration's countdown. */
  discovery: {
    sunsetDate: string;
    daysRemaining: number;
    /**
     * TRUE because Microsoft published a MONTH ("November, 2026"), not a date.
     * The surface must say so — presenting an invented day as the vendor's
     * deadline is the same class of false precision as rendering an absent cost
     * as $0.00.
     */
    sunsetDateIsInferred: boolean;
  };
  /**
   * ADR-0104 §D7 — classes that name ONE physical document per site, with more
   * than one ENABLED source.
   *
   * ── Why this is on a live surface and not only in a test ──────────────────
   * The ADR protects this invariant with a regression test, and a test tells
   * CI. It does not tell the operator standing in front of the admin screen the
   * day somebody re-enables a duplicate — and the duplicate that motivated the
   * rule (a frozen `TEREX.xlsx` copy on a departed account) is held off by a
   * BOOLEAN COLUMN, which any admin can flip back with one click from this very
   * product. A guard whose only consumer is CI is invisible exactly where the
   * mistake gets made.
   *
   * Normally empty. Non-empty means some class is about to count every one of
   * its rows twice.
   */
  singleInstanceViolations: { docClass: string; siteId: string | null; sourceIds: string[] }[];
  /**
   * REACHABLE vs WATCHED (ADR-0080) — the guard discovery never had.
   *
   * `null` means no scan has ever run, which is NOT the same as a gap of zero
   * and must not render as one. Likewise a scan carrying `error` proves nothing
   * about the gap: it means Vision could not look.
   */
  reachability: {
    scannedAtISO: string;
    scope: string;
    reachable: number;
    watched: number;
    gapCount: number;
    truncated: boolean;
    error: string | null;
    gap: ReachabilityGapItem[];
  } | null;
}

export async function loadDocIngestHealth(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DocIngestHealth> {
  const [lastRun, lastSuccess, recentRuns, subscriptionRows, staged, oldestStaged] =
    await Promise.all([
      prisma.docIngestSweepRun.findFirst({ orderBy: { started_at: 'desc' } }),
      prisma.docIngestSweepRun.findFirst({
        where: { status: 'ok' },
        orderBy: { started_at: 'desc' },
      }),
      prisma.docIngestSweepRun.findMany({ orderBy: { started_at: 'desc' }, take: 20 }),
      prisma.docIngestSubscription.findMany({
        where: { state: { notIn: ['revoked'] } },
        orderBy: { created_at: 'desc' },
      }),
      prisma.docSourceVersion.count({ where: { staged: true } }),
      prisma.docSourceVersion.findFirst({
        where: { staged: true },
        orderBy: { observed_at: 'asc' },
        select: { observed_at: true },
      }),
    ]);

  // ADR-0104 §D7. Read as ROWS and judged by the shared pure rule, so the live
  // surface and the regression test cannot drift into two different invariants.
  const singleInstanceViolations = findSingleInstanceViolations(
    await prisma.docSource.findMany({
      select: { id: true, doc_class: true, site_id: true, enabled: true },
    }),
  );

  const [total, active, disabled, accessDenied, disappeared, readBlocked, awaitingConfirmation] =
    await Promise.all([
      prisma.docSource.count(),
      prisma.docSource.count({ where: { state: 'active', enabled: true } }),
      prisma.docSource.count({ where: { enabled: false } }),
      prisma.docSource.count({ where: { state: 'access_denied' } }),
      prisma.docSource.count({ where: { state: 'disappeared' } }),
      prisma.docSource.count({ where: { read_blocked_at: { not: null } } }),
      prisma.docSource.count({
        where: { doc_class: null, classification_attempted_at: { not: null }, kind: 'file' },
      }),
    ]);

  const reachability = await latestReachabilityScan(prisma);

  const [openAnomalies, criticalAnomalies, acknowledgedAnomalies] = await Promise.all([
    prisma.docIngestAnomaly.count({ where: { status: 'open' } }),
    prisma.docIngestAnomaly.count({ where: { status: 'open', severity: 'critical' } }),
    prisma.docIngestAnomaly.count({ where: { status: 'acknowledged' } }),
  ]);

  // Count back from the newest run to the last success. `halted` counts as a
  // failure here on purpose: a halted sweep is a sweep that is not sweeping,
  // whatever the reason, and the operator's question is "is data moving?".
  let consecutiveFailures = 0;
  for (const run of recentRuns) {
    if (run.status === 'ok') break;
    consecutiveFailures += 1;
  }

  const lastSuccessAt = lastSuccess?.started_at ?? null;
  const stale =
    lastSuccessAt === null || now.getTime() - lastSuccessAt.getTime() > DOC_INGEST_SWEEP_STALE_MS;

  const subscriptions: SubscriptionHealth[] = subscriptionRows.map((s) => ({
    id: s.id,
    driveId: s.drive_id,
    state: s.state,
    expiresAtISO: s.expires_at?.toISOString() ?? null,
    lastRenewedISO: s.last_renewed_at?.toISOString() ?? null,
    lastNotificationISO: s.last_notification_at?.toISOString() ?? null,
    notificationsReceived: s.notifications_received,
    validated: s.validated_at !== null,
    lastError: s.last_error,
  }));

  return {
    sweep: {
      lastRunISO: lastRun?.started_at.toISOString() ?? null,
      lastSuccessISO: lastSuccessAt?.toISOString() ?? null,
      lastStatus: lastRun?.status ?? null,
      lastTrigger: lastRun?.trigger ?? null,
      lastError: lastRun?.error ?? null,
      stale,
      staleThresholdHours: Math.round(DOC_INGEST_SWEEP_STALE_MS / 3_600_000),
      consecutiveFailures,
    },
    subscriptions,
    pushProven: subscriptions.some((s) => s.notificationsReceived > 0),
    sources: {
      total,
      active,
      disabled,
      accessDenied,
      disappeared,
      readBlocked,
      awaitingConfirmation,
    },
    anomalies: {
      open: openAnomalies,
      critical: criticalAnomalies,
      acknowledged: acknowledgedAnomalies,
    },
    staged: { count: staged, oldestISO: oldestStaged?.observed_at.toISOString() ?? null },
    singleInstanceViolations,
    discovery: {
      sunsetDate: SHARED_WITH_ME_SUNSET,
      daysRemaining: sharedWithMeDaysRemaining(now),
      sunsetDateIsInferred: SHARED_WITH_ME_SUNSET_IS_INFERRED,
    },
    reachability,
  };
}

/** One row for the sources list on /admin/doc-ingest. */
export interface DocSourceRow {
  id: string;
  displayName: string;
  webUrl: string | null;
  pathHint: string | null;
  ownerUpn: string | null;
  kind: 'file' | 'folder';
  state: string;
  enabled: boolean;
  depth: number;
  sharedByCount: number;
  docClass: string | null;
  siteId: string | null;
  siteName: string | null;
  period: string | null;
  proposedClass: string | null;
  proposedSiteId: string | null;
  proposedSiteName: string | null;
  proposedPeriod: string | null;
  proposedConfidence: number | null;
  proposedReasoning: string | null;
  proposedSource: string | null;
  classificationError: string | null;
  readBlockedReason: string | null;
  lastSeenISO: string;
  lastIngestedISO: string | null;
  sizeBytes: number | null;
  versionCount: number;
}

/**
 * List the sources for the operator surface.
 *
 * Deliberately NOT site-scoped. A source with `site_id = NULL` is UNCLASSIFIED,
 * not cross-site (hard rule #2) — so it cannot appear in a site-scoped list, and
 * the only honest place to show it is an admin-only view that shows everything.
 * `/admin/doc-ingest` is admin-only for exactly that reason.
 */
export async function listDocSources(prisma: PrismaClient): Promise<DocSourceRow[]> {
  const rows = await prisma.docSource.findMany({
    orderBy: [{ doc_class: 'asc' }, { display_name: 'asc' }],
    include: {
      site: { select: { id: true, name: true } },
      proposed_site: { select: { id: true, name: true } },
      _count: { select: { versions: true } },
    },
    take: 500,
  });

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    webUrl: r.web_url,
    pathHint: r.path_hint,
    ownerUpn: r.owner_upn,
    kind: r.kind,
    state: r.state,
    enabled: r.enabled,
    depth: r.depth,
    sharedByCount: r.shared_by_count,
    docClass: r.doc_class,
    siteId: r.site_id,
    siteName: r.site?.name ?? null,
    period: r.period,
    proposedClass: r.proposed_class,
    proposedSiteId: r.proposed_site_id,
    proposedSiteName: r.proposed_site?.name ?? null,
    proposedPeriod: r.proposed_period,
    proposedConfidence: r.proposed_confidence,
    proposedReasoning: r.proposed_reasoning,
    proposedSource: r.proposed_source,
    classificationError: r.classification_error,
    readBlockedReason: r.read_blocked_reason,
    lastSeenISO: r.last_seen_at.toISOString(),
    lastIngestedISO: r.last_ingested_at?.toISOString() ?? null,
    sizeBytes: r.size_bytes,
    versionCount: r._count.versions,
  }));
}

/** One row for /admin/doc-ingest/anomalies, carrying the before/after diff. */
export interface AnomalyRow {
  id: string;
  kind: string;
  severity: string;
  status: string;
  detail: string;
  occurrences: number;
  firstSeenISO: string;
  lastSeenISO: string;
  sourceId: string | null;
  sourceName: string | null;
  versionId: string | null;
  /** Present only for a STAGED revision — this is what apply/discard acts on. */
  staged: boolean;
  context: unknown;
  before: unknown;
  after: unknown;
}

export async function listAnomalies(
  prisma: PrismaClient,
  includeResolved = false,
): Promise<AnomalyRow[]> {
  const rows = await prisma.docIngestAnomaly.findMany({
    where: includeResolved ? {} : { status: { in: ['open', 'acknowledged'] } },
    orderBy: [{ severity: 'desc' }, { last_seen_at: 'desc' }],
    take: 300,
    include: {
      doc_source: { select: { id: true, display_name: true } },
      doc_source_version: {
        select: { id: true, staged: true, parse_summary: true, doc_source_id: true },
      },
    },
  });

  // The "before" of a staged revision is the last APPLIED one — the numbers
  // currently in force. Comparing against the previous OBSERVED revision would
  // show a diff against something that was itself never accepted.
  const previousByVersion = new Map<string, unknown>();
  for (const row of rows) {
    const version = row.doc_source_version;
    if (!version?.staged) continue;
    const previous = await prisma.docSourceVersion.findFirst({
      where: { doc_source_id: version.doc_source_id, applied_at: { not: null } },
      orderBy: { applied_at: 'desc' },
      select: { parse_summary: true },
    });
    previousByVersion.set(version.id, previous?.parse_summary ?? null);
  }

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    detail: r.detail,
    occurrences: r.occurrences,
    firstSeenISO: r.first_seen_at.toISOString(),
    lastSeenISO: r.last_seen_at.toISOString(),
    sourceId: r.doc_source?.id ?? null,
    sourceName: r.doc_source?.display_name ?? null,
    versionId: r.doc_source_version?.id ?? null,
    staged: r.doc_source_version?.staged ?? false,
    context: r.context,
    before: r.doc_source_version ? (previousByVersion.get(r.doc_source_version.id) ?? null) : null,
    after: r.doc_source_version?.parse_summary ?? null,
  }));
}
