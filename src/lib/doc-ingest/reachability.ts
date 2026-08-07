// ADR-0080 §Phase 1 — REACHABLE vs WATCHED.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ The gap this closes                                                       │
// │                                                                           │
// │ Every other layer of this pipeline has a staleness guard (ADR-0057 D9):   │
// │ the sweep has freshness, subscriptions have expiry, ingest has ctag        │
// │ comparison, absorption has the loud zero. DISCOVERY had none. It reported │
// │ `sources_updated: 1` on all 902 sweeps since 2026-07-29 and that number   │
// │ was never compared against anything, so "we can see one document" and     │
// │ "one document exists" were indistinguishable.                             │
// │                                                                           │
// │ Measured live 2026-08-07: `sharedWithMe` returned 1 item; the tenant      │
// │ actually holds 11 documents Vision can read within its own document       │
// │ universe, of which it was watching 3. The enumeration was under-reporting │
// │ by 8 and nothing in the system could say so.                              │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── This module NEVER registers anything ────────────────────────────────────
// It compares and it reports. It does not create a `doc_source`, does not
// classify, does not ingest, does not download a byte. That restraint is
// load-bearing, not timidity: the probe runs on `POST /search/query`, which
// returns everything the identity CAN READ rather than everything shared WITH
// it, and Vision holds `Sites.Read.All`. Auto-adopting what this finds would
// start ingesting Night Shelter case-management files and HR W-9 lists. The gap
// is a question for a human, and registering the answer is Bill's click through
// the existing `/admin/doc-ingest` register-by-URL path (O-2).
//
// ── The bound is STATED, not implied ────────────────────────────────────────
// The scan is scoped (`docIngestReachabilityScope()`), so it can only ever find
// a LOWER BOUND on the gap. Every surface that renders the number also renders
// the scope string that produced it, and `truncated` says when Graph still had
// more to give. Same discipline as `depth_limit_reached`: bounding the walk is
// correct, being quiet about what the bound excluded is not.

import type { PrismaClient } from '@prisma/client';
import type { DocIngestSearch, GraphDriveItem } from './graph';
import { docIngestReachabilityLimit, docIngestReachabilityScope } from './pipeline-config';
import { raiseAnomaly, resolveAnomaly, SOURCES_PAGE_PATH } from './anomalies';
import { sourceKey } from './discovery';

/** The stable subject for the gap anomaly — one alert, not one per document. */
export const REACHABILITY_SUBJECT = 'discovery:reachability';

export interface ReachabilityGapItem {
  driveId: string;
  itemId: string;
  name: string;
  webUrl: string | null;
  /** `createdBy`, when Search supplied it — who would have to be asked about it. */
  ownerHint: string | null;
  lastModifiedAt: string | null;
  sizeBytes: number | null;
}

export interface ReachabilityScanResult {
  /** The exact KQL issued. Rendered verbatim wherever the counts are rendered. */
  scope: string;
  /** Documents in scope that Vision can read. */
  reachable: number;
  /** Of those, how many are already `doc_sources` rows. */
  watched: number;
  /** Reachable-but-unwatched. A LOWER BOUND when `truncated`. */
  gap: ReachabilityGapItem[];
  /** Graph still had results when the cap was hit — the gap is under-stated. */
  truncated: boolean;
  /** Non-null when the probe could not run. NEVER reported as a gap of zero. */
  error: string | null;
  anomaliesRaised: number;
}

export interface RunReachabilityScanOptions {
  now?: Date;
  scope?: string;
  limit?: number;
  /** Retained scan history. Older rows and their items are pruned each run. */
  keepScans?: number;
}

/**
 * Compare what Vision can reach against what it is watching, and record it.
 *
 * Never throws. A probe failure is recorded as a FAILED scan with the reason and
 * raises the anomaly — the one thing it must never do is return `gap: []` when
 * it simply could not look, because a silent zero here would re-create exactly
 * the invisible under-count this module exists to end.
 */
export async function runReachabilityScan(
  prisma: PrismaClient,
  search: DocIngestSearch,
  options: RunReachabilityScanOptions = {},
): Promise<ReachabilityScanResult> {
  const now = options.now ?? new Date();
  const scope = options.scope ?? docIngestReachabilityScope();
  const limit = options.limit ?? docIngestReachabilityLimit();
  const keepScans = options.keepScans ?? 50;

  let found: { items: GraphDriveItem[]; total: number | null; truncated: boolean };
  try {
    found = await search.searchDriveItems(scope, limit);
  } catch (e) {
    const reason =
      `The reachability probe could not run, so Vision CANNOT currently tell whether it is ` +
      `missing documents: ${describe(e)}. Scope was ${scope}.`;
    await prisma.docIngestReachabilityScan.create({
      data: {
        scanned_at: now,
        scope_query: scope,
        reachable_count: 0,
        watched_count: 0,
        gap_count: 0,
        truncated: false,
        error: reason,
      },
    });
    const res = await raiseAnomaly(prisma, {
      kind: 'discovery_gap',
      subject: REACHABILITY_SUBJECT,
      detail: reason,
      context: { scope },
      now,
    });
    return {
      scope,
      reachable: 0,
      watched: 0,
      gap: [],
      truncated: false,
      error: reason,
      anomaliesRaised: res.raised ? 1 : 0,
    };
  }

  // Folders are not documents. A shared folder is a container Vision traverses,
  // and counting one as an unwatched document would manufacture a permanent gap
  // that no operator action could ever close.
  const files = found.items.filter((i) => !i.isFolder);

  // Dedup on the SAME identity rule discovery uses (D8): `(driveId, itemId)`.
  // Search can return one document twice across pages; two hits are not two
  // documents, and counting them as such would inflate the gap.
  const byKey = new Map<string, GraphDriveItem>();
  for (const item of files) byKey.set(sourceKey(item.driveId, item.id), item);

  // EVERY source counts as watched, including disabled ones. A document Bill
  // deliberately switched off is not a discovery gap — re-reporting it every
  // sweep would train him to ignore the alert, which is ADR-0037 question 4.
  const sources = await prisma.docSource.findMany({
    select: { drive_id: true, item_id: true },
  });
  const watchedKeys = new Set(sources.map((s) => sourceKey(s.drive_id, s.item_id)));

  const gap: ReachabilityGapItem[] = [];
  let watched = 0;
  for (const [key, item] of byKey) {
    if (watchedKeys.has(key)) {
      watched += 1;
      continue;
    }
    gap.push({
      driveId: item.driveId,
      itemId: item.id,
      name: item.name,
      webUrl: item.webUrl,
      ownerHint: item.createdByUpn ?? item.ownerUpn ?? null,
      lastModifiedAt: item.lastModifiedAt,
      sizeBytes: item.size,
    });
  }

  // Newest first: a document shared this morning is the one worth looking at.
  gap.sort((a, b) => (b.lastModifiedAt ?? '').localeCompare(a.lastModifiedAt ?? ''));

  const scan = await prisma.docIngestReachabilityScan.create({
    data: {
      scanned_at: now,
      scope_query: scope,
      reachable_count: byKey.size,
      watched_count: watched,
      gap_count: gap.length,
      truncated: found.truncated,
      error: null,
    },
  });

  if (gap.length > 0) {
    await prisma.docIngestReachableItem.createMany({
      data: gap.map((g) => ({
        scan_id: scan.id,
        drive_id: g.driveId,
        item_id: g.itemId,
        name: g.name,
        web_url: g.webUrl,
        owner_hint: g.ownerHint,
        last_modified_at: g.lastModifiedAt ? new Date(g.lastModifiedAt) : null,
        size_bytes: g.sizeBytes === null ? null : clampInt(g.sizeBytes),
      })),
    });
  }

  // Keep the counts as history (cheap) but only the newest scans' ITEM rows.
  const stale = await prisma.docIngestReachabilityScan.findMany({
    orderBy: { scanned_at: 'desc' },
    skip: keepScans,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.docIngestReachabilityScan.deleteMany({
      where: { id: { in: stale.map((s) => s.id) } },
    });
  }

  let anomaliesRaised = 0;
  if (gap.length > 0) {
    const res = await raiseAnomaly(prisma, {
      kind: 'discovery_gap',
      subject: REACHABILITY_SUBJECT,
      detail: describeGap({
        scope,
        reachable: byKey.size,
        watched,
        gap,
        truncated: found.truncated,
      }),
      context: {
        scope,
        reachable: byKey.size,
        watched,
        gapCount: gap.length,
        truncated: found.truncated,
        names: gap.map((g) => g.name),
      },
      now,
    });
    if (res.raised) anomaliesRaised += 1;
  } else {
    await resolveAnomaly(
      prisma,
      'discovery_gap',
      REACHABILITY_SUBJECT,
      `Every document in scope is being watched (${watched} of ${byKey.size}).`,
      now,
    );
  }

  return {
    scope,
    reachable: byKey.size,
    watched,
    gap,
    truncated: found.truncated,
    error: null,
    anomaliesRaised,
  };
}

/**
 * The operator-facing sentence. It NAMES the documents, because "8 documents are
 * unwatched" is not actionable and "DR3 Machine List (2).xlsx is unwatched" is.
 */
export function describeGap(
  r: Pick<ReachabilityScanResult, 'scope' | 'reachable' | 'watched' | 'gap' | 'truncated'>,
): string {
  const names = r.gap.map((g) => `"${g.name}"`).join(', ');
  return (
    `Vision can READ ${r.reachable} document(s) in scope but is WATCHING only ${r.watched}. ` +
    `${r.gap.length} reachable document(s) are not being watched: ${names}. ` +
    `Nothing has been registered automatically — a document only enters the pipeline when you ` +
    `register it, because Vision can reach far more of the tenant than it has any business ingesting. ` +
    `${r.truncated ? 'The result set was TRUNCATED at the scan cap, so the real gap is LARGER than this. ' : ''}` +
    `Scope: ${r.scope}`
  );
}

/** The newest scan, for the health read model. Null when none has ever run. */
export async function latestReachabilityScan(prisma: PrismaClient): Promise<{
  scannedAtISO: string;
  scope: string;
  reachable: number;
  watched: number;
  gapCount: number;
  truncated: boolean;
  error: string | null;
  gap: ReachabilityGapItem[];
} | null> {
  const scan = await prisma.docIngestReachabilityScan.findFirst({
    orderBy: { scanned_at: 'desc' },
  });
  if (!scan) return null;

  const items = await prisma.docIngestReachableItem.findMany({
    where: { scan_id: scan.id },
    orderBy: { last_modified_at: 'desc' },
  });

  return {
    scannedAtISO: scan.scanned_at.toISOString(),
    scope: scan.scope_query,
    reachable: scan.reachable_count,
    watched: scan.watched_count,
    gapCount: scan.gap_count,
    truncated: scan.truncated,
    error: scan.error,
    gap: items.map((i) => ({
      driveId: i.drive_id,
      itemId: i.item_id,
      name: i.name,
      webUrl: i.web_url,
      ownerHint: i.owner_hint,
      lastModifiedAt: i.last_modified_at?.toISOString() ?? null,
      sizeBytes: i.size_bytes,
    })),
  };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `size_bytes` is INTEGER in Postgres — clamp rather than throw (mirrors discovery.ts). */
function clampInt(v: number): number {
  return Math.min(Math.max(Math.trunc(v), 0), 2_147_483_647);
}

/**
 * One line for Bill's 06:00 digest, or null when there is nothing to say.
 *
 * Same shape and same reasoning as `docIngestReauthWarning` (ADR-0067 Am. A
 * §A.6): a WARNING line, not a queue, because the AP digest sends warnings even
 * when its own queue is empty. That rule is what makes this visible at all — a
 * discovery gap produces no AP items, so an items-gated line would be invisible
 * exactly when it mattered.
 *
 * THREE distinct silences, and only one of them is good news:
 *   • no scan has ever run   → SAY SO. Vision cannot answer the question.
 *   • the last scan errored  → SAY SO. Vision could not look.
 *   • gap of zero            → say nothing. This is the only quiet case.
 *
 * Collapsing the first two into silence would rebuild, in the digest, the exact
 * illusion this feature exists to destroy: a surface that looks fine because
 * nothing was measured.
 *
 * ── …but ONLY when there is an ingester to be measured ─────────────────────
 * All of the above is conditional on document ingestion actually being CONNECTED.
 * If it is not, "discovery has never been checked" is true and useless: the
 * reason is that nothing is ingesting at all, `docIngestReauthWarning` already
 * says so, and repeating it is the deduplicate-against-root-cause failure of
 * ADR-0037 question 4. Worse, an unconditional line would defeat the AP digest's
 * empty-suppression on EVERY quiet day forever, which is how a warning becomes
 * wallpaper.
 *
 * The window in which "connected but never scanned" is true closes by itself
 * within one sweep interval of deployment, and that is exactly the window in
 * which somebody should be told the guard is not yet reporting.
 */
export async function docIngestDiscoveryGapWarning(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<string | null> {
  const connection = await prisma.docIngestConnection.findUnique({
    where: { id: 'singleton' },
    select: { state: true },
  });
  if (!connection || connection.state !== 'connected') return null;

  const scan = await prisma.docIngestReachabilityScan.findFirst({
    orderBy: { scanned_at: 'desc' },
    select: {
      scanned_at: true,
      scope_query: true,
      reachable_count: true,
      watched_count: true,
      gap_count: true,
      truncated: true,
      error: true,
      id: true,
    },
  });

  if (!scan) {
    return (
      `Document discovery has never been checked for completeness — Vision CANNOT say whether ` +
      `documents are being missed. This is not the same as there being none.`
    );
  }

  if (scan.error !== null) {
    return (
      `The document-discovery completeness check could not run, so Vision CANNOT say whether ` +
      `documents are being missed: ${scan.error}`
    );
  }

  if (scan.gap_count === 0) return null;

  const items = await prisma.docIngestReachableItem.findMany({
    where: { scan_id: scan.id },
    orderBy: { last_modified_at: 'desc' },
    select: { name: true },
    take: 10,
  });
  const names = items.map((i) => i.name).join(', ');
  const more = scan.gap_count > items.length ? `, +${scan.gap_count - items.length} more` : '';

  // A stale scan is its own warning: the gap number is only as good as the run
  // that produced it, and a check that stopped running looks identical to a
  // check that keeps finding nothing.
  const ageHours = Math.floor((now.getTime() - scan.scanned_at.getTime()) / 3_600_000);
  const stale = ageHours >= 24 ? ` (last checked ${ageHours}h ago — this figure may be stale)` : '';

  return (
    `${scan.gap_count} document(s) are readable by Vision but NOT being watched${stale}: ` +
    `${names}${more}. ` +
    `${scan.truncated ? 'The scan hit its cap, so the real number is HIGHER. ' : ''}` +
    `Nothing is registered automatically — review them at ${SOURCES_PAGE_PATH}.`
  );
}
