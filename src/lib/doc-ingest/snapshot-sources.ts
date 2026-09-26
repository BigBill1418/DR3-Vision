// ADR-0139 — is Vision watching the LIVE document, or a frozen copy of it?
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ The gap this closes                                                       │
// │                                                                           │
// │ ADR-0067 D1: "Vision reads the live file." Every guard in this pipeline   │
// │ checks that Vision keeps up with the file it WATCHES — ctag comparison,   │
// │ the sweep ledger, reachability (ADR-0080). None asks whether the watched  │
// │ file is the one anybody edits.                                            │
// │                                                                           │
// │ Measured 2026-09-25: 9 of 11 watched documents live in the owner's        │
// │ `root:/Attachments` folder — the copy Outlook makes when a file is sent    │
// │ "as a OneDrive attachment". Their cTag revision was 2; the originals, in  │
// │ `DR3/...`, sat at revisions 68–1172. Every sweep for 40 days was          │
// │ truthfully `ok` with 0 new versions, because the copies never change.     │
// │ One original (DR3 Meeting Notes Log 2026) was edited after its copy was   │
// │ made, and Vision could not know.                                          │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── Why this asks Graph instead of reading `path_hint` ──────────────────────
// `path_hint` is whatever the ENUMERATION route happened to carry. Measured on
// the same day: two of the nine copies had an empty `path_hint` while a direct
// `GET /drives/{d}/items/{i}` put them in `root:/Attachments`. A check that
// trusted the column would have reported 7, and "7 of 9" is exactly the kind of
// quiet under-count ADR-0080 exists to end. So the parent path comes from a
// direct item GET, every time.
//
// ── Why "and has not changed in N days" ─────────────────────────────────────
// Someone COULD adopt an attachment copy as their working file. Then it moves,
// and it is live. The failure is the pair — a copy AND frozen — so the rule is
// the pair, and a copy that is being edited never trips it.
//
// ── Why once a day ──────────────────────────────────────────────────────────
// This is structural, not an outage: it cannot appear or clear in 15 minutes
// except by a human sharing a file or disabling a source. Running it on every
// sweep would be ~1,000 extra Graph GETs a day for the same answer, and (DR3's
// ntfy helper does not buffer quiet hours) its first page would land whenever
// the deploy happened to. The window puts the page at the start of the working
// day. A MANUAL sweep always runs it, so an operator who just fixed a share can
// see it clear immediately.
//
// ── This module NEVER changes a source ──────────────────────────────────────
// It reports. Disabling a copy, or registering the original, is Bill's decision
// through /admin/doc-ingest — the original may need to be SHARED first, which is
// a write in someone else's OneDrive that this integration has no standing to
// make.

import type { PrismaClient } from '@prisma/client';
import type { DocIngestGraph } from './graph';
import { raiseAnomaly, resolveAnomaly } from './anomalies';

/** One open row for the whole condition — one page, never one per document. */
export const SNAPSHOT_SUBJECT = 'discovery:snapshot_sources';

/** A copy unchanged for this long is treated as frozen. */
export const SNAPSHOT_STALE_DAYS = 14;

/** Pacific wall-clock window in which a SCHEDULED sweep runs the check. */
export const SNAPSHOT_CHECK_HOUR_PT = 8;
export const SNAPSHOT_CHECK_WINDOW_MINUTES = 30;

/**
 * Outlook's "share as OneDrive link" upload folder, at the drive root.
 * Graph renders it `/drives/{id}/root:/Attachments`. Anchored at `root:` so a
 * user folder that merely happens to be CALLED Attachments further down the tree
 * is not mistaken for it.
 */
export function isOutlookAttachmentPath(parentPath: string | null | undefined): boolean {
  if (!parentPath) return false;
  return /\/root:\/Attachments\/?$/i.test(parentPath.trim());
}

/** True for the sweeps that should run the check: every manual one, and the first scheduled ones after 08:00 PT. */
export function shouldRunSnapshotCheck(now: Date, trigger: string): boolean {
  if (trigger === 'manual') return true;
  if (trigger !== 'scheduled') return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return hour === SNAPSHOT_CHECK_HOUR_PT && minute < SNAPSHOT_CHECK_WINDOW_MINUTES;
}

export interface SnapshotFinding {
  sourceId: string;
  name: string;
  ownerUpn: string | null;
  parentPath: string;
  lastModifiedAt: string | null;
}

export interface SnapshotCheckResult {
  checked: number;
  snapshots: SnapshotFinding[];
  /** Sources whose item GET failed — the check cannot call them clear. */
  unreadable: number;
  raised: boolean;
  resolved: boolean;
}

export interface SnapshotCheckOptions {
  now?: Date;
  staleDays?: number;
}

export async function runSnapshotSourceCheck(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  options: SnapshotCheckOptions = {},
): Promise<SnapshotCheckResult> {
  const now = options.now ?? new Date();
  const staleMs = (options.staleDays ?? SNAPSHOT_STALE_DAYS) * 24 * 60 * 60 * 1000;

  // Disabled sources are excluded on purpose: disabling a copy is one of the two
  // ways to answer this finding ("this document is retired, stop watching it").
  const sources = await prisma.docSource.findMany({
    where: { state: 'active', enabled: true, kind: 'file' },
    select: { id: true, drive_id: true, item_id: true, display_name: true, owner_upn: true },
  });

  const snapshots: SnapshotFinding[] = [];
  let unreadable = 0;
  for (const source of sources) {
    let item;
    try {
      item = await graph.getItem(source.drive_id, source.item_id);
    } catch {
      // Access loss / deletion are discovery's findings (access_denied,
      // source_disappeared). Here it only means "not proven clear".
      unreadable += 1;
      continue;
    }
    if (!isOutlookAttachmentPath(item.parentPath)) continue;
    const modified = item.lastModifiedAt ? Date.parse(item.lastModifiedAt) : NaN;
    // An unknown modification time is NOT evidence of life. Treat it as frozen.
    const frozen = Number.isNaN(modified) || now.getTime() - modified >= staleMs;
    if (!frozen) continue;
    snapshots.push({
      sourceId: source.id,
      name: source.display_name,
      ownerUpn: source.owner_upn,
      parentPath: item.parentPath ?? '',
      lastModifiedAt: item.lastModifiedAt,
    });
  }

  if (snapshots.length > 0) {
    const list = snapshots
      .map(
        (s) =>
          `"${s.name}" (${s.ownerUpn ?? 'owner unknown'}, last changed ${s.lastModifiedAt?.slice(0, 10) ?? 'unknown'})`,
      )
      .join('; ');
    const res = await raiseAnomaly(prisma, {
      kind: 'snapshot_source',
      subject: SNAPSHOT_SUBJECT,
      detail:
        `${snapshots.length} of ${sources.length} watched documents are Outlook attachment copies ` +
        `(OneDrive "Attachments" folder) that have not changed in ${options.staleDays ?? SNAPSHOT_STALE_DAYS}+ days — ` +
        `frozen snapshots, not the live files. Edits to the originals never reach Vision, and every ` +
        `sweep still reads "ok". For each: have the owner share the ORIGINAL with docs-dr3@svdp.us and ` +
        `register it, or, if the document is retired, disable the copy. ${list}.`,
      context: {
        count: snapshots.length,
        watched: sources.length,
        staleDays: options.staleDays ?? SNAPSHOT_STALE_DAYS,
        sources: snapshots.map((s) => ({
          id: s.sourceId,
          name: s.name,
          owner: s.ownerUpn,
          lastModifiedAt: s.lastModifiedAt,
        })),
      },
      now,
    });
    return { checked: sources.length, snapshots, unreadable, raised: res.raised, resolved: false };
  }

  // Clear only on a COMPLETE look. A failed GET is "could not see", and
  // resolving on it would turn a Graph blip into an all-clear.
  if (unreadable > 0) {
    return { checked: sources.length, snapshots, unreadable, raised: false, resolved: false };
  }
  await resolveAnomaly(
    prisma,
    'snapshot_source',
    SNAPSHOT_SUBJECT,
    'Every watched document is a live file (no frozen Outlook attachment copies).',
    now,
  );
  return { checked: sources.length, snapshots, unreadable, raised: false, resolved: true };
}
