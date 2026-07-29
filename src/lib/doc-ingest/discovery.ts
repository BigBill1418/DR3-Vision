// ADR-0067 §3.2 D4/D8 — shared-item discovery and folder traversal.
//
// What "discovery" means here: enumerate everything shared with the service
// account, walk inside shared FOLDERS to a bounded depth, and reconcile that
// against `doc_sources` so the table is the current truth about what Vision is
// watching.
//
// ── The one identity rule everything rests on (D8) ──────────────────────────
// A source is keyed on `(drive_id, item_id)` — the IMMUTABLE driveItem id in the
// drive that actually hosts it. A rename is not a new file. A move is not a new
// file. Two people sharing the same document are not two files. Keying on name
// or path would break all three, and would break them SILENTLY: you would get a
// duplicate source, classify it a second time, and ingest the same document
// twice under two identities.
//
// This is also why `projectDriveItem` unwraps the `remoteItem` facet in
// graph.ts: `sharedWithMe` hands back a LOCAL stub whose own id belongs to the
// service account's drive. Keying on the stub would make every source look like
// it lived in one drive.

import type { PrismaClient } from '@prisma/client';
import {
  DocIngestAccessDeniedError,
  DocIngestNotFoundError,
  type DocIngestGraph,
  type GraphDriveItem,
} from './graph';
import { docIngestMaxDepth } from './pipeline-config';
import { raiseAnomaly, resolveAnomaly } from './anomalies';

/**
 * The enumeration seam.
 *
 * ⚠ `GET /me/drive/sharedWithMe` is DEPRECATED (see `SHARED_WITH_ME_SUNSET`).
 * Discovery goes through this interface — rather than calling Graph directly —
 * precisely so replacing the enumeration when it stops returning data is ONE
 * implementation swap and not a rewrite of the traversal, dedup and
 * reconciliation logic below, none of which cares where the roots came from.
 */
export interface SharedItemSource {
  listSharedRoots(): Promise<GraphDriveItem[]>;
}

export function graphSharedItemSource(graph: DocIngestGraph): SharedItemSource {
  return { listSharedRoots: () => graph.listSharedWithMe() };
}

export interface DiscoveryResult {
  discovered: number;
  updated: number;
  /** Sources that were being watched and are no longer reachable. */
  lostAccess: number;
  disappeared: number;
  /** Distinct (driveId, itemId) pairs that arrived more than once. */
  deduped: number;
  anomaliesRaised: number;
}

interface Seen {
  item: GraphDriveItem;
  depth: number;
  parentItemId: string | null;
  /** How many separate shares resolved to this same item. */
  shareCount: number;
}

export interface RunDiscoveryOptions {
  now?: Date;
  maxDepth?: number;
}

/**
 * Enumerate, traverse, and reconcile.
 *
 * Never throws for a per-item problem: an unreachable child raises an anomaly
 * and the walk continues. A failure to enumerate AT ALL does throw — that is the
 * sweep's problem to record, and pretending discovery succeeded with zero
 * results would silently mark every source as disappeared.
 */
export async function runDiscovery(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  source: SharedItemSource = graphSharedItemSource(graph),
  options: RunDiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const now = options.now ?? new Date();
  const maxDepth = options.maxDepth ?? docIngestMaxDepth();

  const roots = await source.listSharedRoots();

  // ── 1. Dedup the roots ────────────────────────────────────────────────────
  // Two colleagues sharing the same workbook produce two entries that resolve to
  // ONE (driveId, itemId). They must become one logical source with one
  // classification — otherwise Bill is asked to classify the same document
  // twice and the two rows can disagree.
  const seen = new Map<string, Seen>();
  let deduped = 0;
  for (const item of roots) {
    const key = sourceKey(item.driveId, item.id);
    const prior = seen.get(key);
    if (prior) {
      prior.shareCount += 1;
      deduped += 1;
      continue;
    }
    seen.set(key, { item, depth: 0, parentItemId: null, shareCount: 1 });
  }

  // ── 2. Walk inside shared folders ─────────────────────────────────────────
  // A shared folder that did not pick up later additions would be worthless —
  // that is the entire reason folder-sharing is offered.
  let anomaliesRaised = 0;
  const queue: Seen[] = [...seen.values()].filter((s) => s.item.isFolder);

  while (queue.length > 0) {
    const folder = queue.shift();
    if (!folder) break;

    // Bill's kill switch stops the walk too: a disabled folder should cost
    // nothing per sweep, not just be ignored at the end.
    if (await isDisabled(prisma, folder.item.driveId, folder.item.id)) continue;

    if (folder.depth >= maxDepth) {
      // Hitting the limit means files exist that Vision is NOT watching. Bounded
      // enumeration is correct; being quiet about what the bound excluded is not.
      const res = await raiseAnomaly(prisma, {
        kind: 'depth_limit_reached',
        subject: sourceKey(folder.item.driveId, folder.item.id),
        detail:
          `Shared folder "${folder.item.name}" is nested deeper than the traversal limit ` +
          `(${maxDepth}). Files below this level are NOT being watched. Raise ` +
          `DOC_INGEST_MAX_DEPTH or ask the owner to share the inner folder directly.`,
        context: { depth: folder.depth, maxDepth, driveId: folder.item.driveId },
        now,
      });
      if (res.raised) anomaliesRaised += 1;
      continue;
    }

    let children: GraphDriveItem[];
    try {
      children = await graph.listChildren(folder.item.driveId, folder.item.id);
    } catch (e) {
      anomaliesRaised += await recordReachabilityFailure(prisma, folder.item, e, now);
      continue;
    }

    for (const child of children) {
      const key = sourceKey(child.driveId, child.id);
      const prior = seen.get(key);
      if (prior) {
        // The same item reachable by two routes (shared directly AND inside a
        // shared folder). One logical source; keep the SHALLOWER placement,
        // which is the one a human actually chose to share.
        prior.shareCount += 1;
        deduped += 1;
        continue;
      }
      const entry: Seen = {
        item: child,
        depth: folder.depth + 1,
        parentItemId: folder.item.id,
        shareCount: 1,
      };
      seen.set(key, entry);
      if (child.isFolder) queue.push(entry);
    }
  }

  // ── 3. Upsert ─────────────────────────────────────────────────────────────
  let discovered = 0;
  let updated = 0;
  for (const entry of seen.values()) {
    const wasNew = await upsertSource(prisma, entry, now);
    if (wasNew) discovered += 1;
    else updated += 1;
  }

  // ── 4. Reconcile what vanished ────────────────────────────────────────────
  const { lostAccess, disappeared, raised } = await reconcileMissing(
    prisma,
    graph,
    new Set(seen.keys()),
    now,
  );

  return {
    discovered,
    updated,
    lostAccess,
    disappeared,
    deduped,
    anomaliesRaised: anomaliesRaised + raised,
  };
}

export function sourceKey(driveId: string, itemId: string): string {
  return `${driveId}:${itemId}`;
}

async function isDisabled(prisma: PrismaClient, driveId: string, itemId: string): Promise<boolean> {
  const row = await prisma.docSource.findUnique({
    where: { drive_id_item_id: { drive_id: driveId, item_id: itemId } },
    select: { enabled: true },
  });
  return row ? !row.enabled : false;
}

/**
 * Insert or refresh one source. Returns true when the row was created.
 *
 * Note what is NOT written on update: `site_id`, `doc_class`, `enabled`.
 * `site_id`/`doc_class` are decisions a human made and discovery has no standing
 * to revise them; `enabled` is Bill's kill switch and re-seeing a file is not
 * consent to re-enable it. `display_name` and `path_hint` ARE refreshed — a
 * rename must show up, and it is not a new identity (D8).
 */
async function upsertSource(prisma: PrismaClient, entry: Seen, now: Date): Promise<boolean> {
  const { item } = entry;
  const existing = await prisma.docSource.findUnique({
    where: { drive_id_item_id: { drive_id: item.driveId, item_id: item.id } },
    select: { id: true, state: true, ctag: true, read_blocked_ctag: true },
  });

  const common = {
    kind: item.isFolder ? ('folder' as const) : ('file' as const),
    display_name: item.name,
    web_url: item.webUrl,
    path_hint: item.parentPath,
    owner_upn: item.ownerUpn,
    content_type: item.contentType,
    size_bytes: clampInt(item.size),
    etag: item.etag,
    ctag: item.ctag,
    last_modified_at: item.lastModifiedAt ? new Date(item.lastModifiedAt) : null,
    parent_item_id: entry.parentItemId,
    depth: entry.depth,
    shared_by_count: entry.shareCount,
    last_seen_at: now,
  };

  if (!existing) {
    await prisma.docSource.create({
      data: { drive_id: item.driveId, item_id: item.id, ...common, state: 'active' },
    });
    return true;
  }

  // Seeing it again clears any lost/deleted state — a restored share must not
  // stay marked broken. The matching anomaly is resolved rather than deleted.
  const recovered = existing.state !== 'active';

  // The unreadable latch (D8: "do not retry in a loop") releases only when the
  // CONTENT changes: a new ctag is a genuinely different file and earns exactly
  // one more attempt. Re-seeing the same bytes does not.
  const contentChanged =
    existing.read_blocked_ctag !== null &&
    item.ctag !== null &&
    item.ctag !== existing.read_blocked_ctag;

  await prisma.docSource.update({
    where: { id: existing.id },
    data: {
      ...common,
      ...(recovered ? { state: 'active' as const, disappeared_at: null } : {}),
      ...(contentChanged
        ? { read_blocked_at: null, read_blocked_reason: null, read_blocked_ctag: null }
        : {}),
    },
  });

  if (recovered) {
    const subject = sourceKey(item.driveId, item.id);
    await resolveAnomaly(prisma, 'access_denied', subject, 'Access restored — source seen again.');
    await resolveAnomaly(prisma, 'source_disappeared', subject, 'Source reappeared.');
    await resolveAnomaly(prisma, 'owner_lost', subject, 'Access restored — source seen again.');
  }
  return false;
}

interface ReconcileResult {
  lostAccess: number;
  disappeared: number;
  raised: number;
}

/**
 * Decide what happened to every active source the enumeration did NOT return.
 *
 * Absence alone proves nothing — a file inside a shared folder is legitimately
 * absent from the shared-with-me list — so each one is PROBED directly. 403 and
 * 404 are then kept apart deliberately (ADR-0067 D9): a revoked share and a
 * deleted file look identical at a glance and need completely different operator
 * action. Collapsing them is how "the document is gone" silently becomes "nobody
 * noticed the share lapsed".
 *
 * D8 "deleted file": the row and its version history are RETAINED. Last-known
 * state is the point — deleting our record of a deleted document would destroy
 * the only remaining evidence of what it said.
 */
async function reconcileMissing(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  presentKeys: Set<string>,
  now: Date,
): Promise<ReconcileResult> {
  const tracked = await prisma.docSource.findMany({
    where: { state: 'active' },
    select: {
      id: true,
      drive_id: true,
      item_id: true,
      display_name: true,
      owner_upn: true,
      enabled: true,
    },
  });

  const lost: { source: (typeof tracked)[number]; reason: 'access_denied' | 'disappeared' }[] = [];

  for (const source of tracked) {
    if (presentKeys.has(sourceKey(source.drive_id, source.item_id))) continue;
    // A disabled source is not probed at all: the kill switch means "stop
    // spending Graph calls on this", not "keep checking quietly".
    if (!source.enabled) continue;
    try {
      await graph.getItem(source.drive_id, source.item_id);
      // Reachable but unlisted — a child of a shared folder whose parent was
      // walked, or an enumeration hiccup. Nothing is wrong.
      continue;
    } catch (e) {
      if (e instanceof DocIngestAccessDeniedError) lost.push({ source, reason: 'access_denied' });
      else if (e instanceof DocIngestNotFoundError) lost.push({ source, reason: 'disappeared' });
      // Anything else is transient (5xx, timeout): leave the source alone. A
      // network blip must never mark a healthy document as gone.
    }
  }

  // ── Owner-left detection (D8) ─────────────────────────────────────────────
  // Vision cannot ask Graph whether a person still exists: that needs
  // User.Read.All, and this integration deliberately holds only `User.Read`
  // (its own identity). So "the owner left" is inferred from the one signature
  // that IS observable — EVERY source that owner shared became unreachable in
  // the same pass, while other owners' sources are fine. One revoked share does
  // not look like that; a disabled account does.
  //
  // The inference matters because the alert must NAME the previous owner, and
  // `owner_upn` recorded at discovery is the only place that name still exists
  // once the account is gone.
  const byOwner = new Map<string, typeof lost>();
  for (const entry of lost) {
    const owner = entry.source.owner_upn;
    if (!owner) continue;
    const bucket = byOwner.get(owner) ?? [];
    bucket.push(entry);
    byOwner.set(owner, bucket);
  }

  const ownerLostKeys = new Set<string>();
  for (const [owner, entries] of byOwner) {
    const totalForOwner = await prisma.docSource.count({
      where: { owner_upn: owner, state: 'active', enabled: true },
    });
    // Every one of that owner's sources went at once, and there was more than
    // one — a single share disappearing is just a single share disappearing.
    if (entries.length >= 2 && entries.length === totalForOwner) {
      for (const entry of entries) {
        ownerLostKeys.add(entry.source.id);
      }
      await raiseAnomaly(prisma, {
        kind: 'owner_lost',
        subject: `owner:${owner}`,
        detail:
          `Every document shared by ${owner} (${entries.length}) became unreachable at once — ` +
          `consistent with that account being disabled or the person leaving. ` +
          `Affected: ${entries.map((x) => x.source.display_name).join(', ')}. ` +
          `Vision cannot confirm the account's state (it holds User.Read for itself only), ` +
          `so the alternative explanation is that ${owner} revoked all of the shares.`,
        context: { owner, count: entries.length },
        now,
      });
    }
  }

  let lostAccess = 0;
  let disappeared = 0;
  let raised = 0;

  for (const { source, reason } of lost) {
    await prisma.docSource.update({
      where: { id: source.id },
      data: {
        state: reason === 'access_denied' ? 'access_denied' : 'disappeared',
        disappeared_at: now,
      },
    });

    if (reason === 'access_denied') lostAccess += 1;
    else disappeared += 1;

    // Already covered by the owner-level alert — a per-file page for each of a
    // departed colleague's twelve documents is exactly the deduplication failure
    // ADR-0037's question 4 asks about.
    if (ownerLostKeys.has(source.id)) continue;

    const res = await raiseAnomaly(prisma, {
      kind: reason === 'access_denied' ? 'access_denied' : 'source_disappeared',
      subject: sourceKey(source.drive_id, source.item_id),
      docSourceId: source.id,
      detail:
        reason === 'access_denied'
          ? `Vision can no longer read "${source.display_name}"${
              source.owner_upn ? ` (shared by ${source.owner_upn})` : ''
            }. The share was most likely revoked. Nothing from this document is being updated.`
          : `"${source.display_name}"${
              source.owner_upn ? ` (shared by ${source.owner_upn})` : ''
            } no longer exists in Microsoft. Its last known state and version history are retained.`,
      context: { driveId: source.drive_id, itemId: source.item_id, owner: source.owner_upn },
      now,
    });
    if (res.raised) raised += 1;
  }

  return { lostAccess, disappeared, raised };
}

/** Turn a per-item Graph failure into the right state + anomaly. Returns anomalies raised. */
async function recordReachabilityFailure(
  prisma: PrismaClient,
  item: GraphDriveItem,
  error: unknown,
  now: Date,
): Promise<number> {
  const subject = sourceKey(item.driveId, item.id);
  if (error instanceof DocIngestAccessDeniedError) {
    const res = await raiseAnomaly(prisma, {
      kind: 'access_denied',
      subject,
      detail: `Vision can no longer list the contents of shared folder "${item.name}". Files inside it are not being watched.`,
      context: { driveId: item.driveId, itemId: item.id },
      now,
    });
    return res.raised ? 1 : 0;
  }
  if (error instanceof DocIngestNotFoundError) {
    const res = await raiseAnomaly(prisma, {
      kind: 'source_disappeared',
      subject,
      detail: `Shared folder "${item.name}" no longer exists in Microsoft.`,
      context: { driveId: item.driveId, itemId: item.id },
      now,
    });
    return res.raised ? 1 : 0;
  }
  // Transient — the next sweep retries. Recording a `download_failed`-style
  // anomaly for a 5xx would page on a hiccup.
  return 0;
}

/**
 * `size_bytes` is INTEGER in Postgres (matching `file_drops.byte_size`). A file
 * larger than 2 GiB would overflow it — clamp rather than throw, because the
 * oversize guard is what actually refuses the file and the size column is only
 * ever displayed.
 */
function clampInt(v: number | null): number | null {
  if (v === null) return null;
  return Math.min(Math.max(Math.trunc(v), 0), 2_147_483_647);
}
