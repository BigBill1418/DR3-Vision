// ADR-0057 D4 — reconciliation FEED (sync → queue writer).
//
// The classifier (`reconcile-detect.ts`) is pure. This module is the
// side-effecting caller its docstring names: it loads the operational source set
// + the active mirror rows, runs the classifier against the REAL source-carrying
// fields —
//   - Materials__c.Account__r.Name            (processed mirror)
//   - Haul_Request__c.Collection_Site__c /
//       Collection_Source__c                  (hauls mirror)
// — and inserts any UNMATCHED name as a `new_record` candidate in
// `mymrc_reconciliation_queue`. It NEVER writes `sources` (or any ops table): the
// queue is the ONLY gate to the operational tables (ADR-0057 D4); an admin
// approves each candidate in `src/lib/reconcile/apply.ts`. This is how new
// collection sites surface for review instead of silently landing with a null FK.
//
// Dedup is TWO-layer: the classifier dedups within a single pass; THIS module
// dedups (a) across the two feeds and (b) across runs — a name that already has a
// `new_record → sources` queue row (any status) is never re-queued, so the same
// unmatched name is not surfaced every hourly tick.
//
// Bundle constraint (tsconfig.mymrc.json): compiled standalone — no `@/…`
// imports. Prisma is INJECTED; only its TYPES are imported.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  detectHaulRecordChanges,
  detectProcessedRecordChanges,
  normalizeSourceName,
  type ReconciliationCandidate,
} from './reconcile-detect';

export type FeedLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface FeedReconciliationContext {
  prisma: PrismaClient;
  log?: FeedLogger;
}

export interface FeedReconciliationResult {
  /** Distinct new_record candidates the processed classifier produced this tick. */
  processedCandidates: number;
  /** Distinct new_record candidates the hauls classifier produced this tick. */
  haulCandidates: number;
  /** Rows actually inserted into the queue (post cross-feed + cross-run dedup). */
  queued: number;
  /** Candidates suppressed because the name was already queued in a prior run. */
  skippedExisting: number;
}

/** A mirror row selected for classification (payload + site for carrier ranking). */
interface MirrorRowForFeed {
  id: string;
  payload: Prisma.JsonValue;
  site_id: string | null;
}

/**
 * Rank rows whose `site_id` is already resolved FIRST. The classifier keeps the
 * first carrying row per unknown name; a resolved carrier means an eventual
 * approve can scope the new `sources` row (apply.ts derives site_id from the
 * mirror row — an unresolved one is not approvable). Stable within each group.
 */
function siteResolvedFirst(rows: readonly MirrorRowForFeed[]): MirrorRowForFeed[] {
  return [...rows].sort((a, b) => (a.site_id ? 0 : 1) - (b.site_id ? 0 : 1));
}

/**
 * Feed the reconciliation queue with new collection-site candidates. Runs once
 * per sync tick (after the per-site mirror upserts). Idempotent: safe to re-run —
 * the cross-run dedup makes repeated ticks a no-op until a genuinely new source
 * name appears. Never writes an operational table.
 */
export async function feedReconciliationQueue(
  ctx: FeedReconciliationContext,
): Promise<FeedReconciliationResult> {
  const log = ctx.log ?? ((): void => undefined);
  const { prisma } = ctx;

  const [sources, aliases] = await Promise.all([
    prisma.source.findMany({ select: { id: true, name: true } }),
    prisma.sourceAlias.findMany({ select: { alias: true, source_id: true } }),
  ]);

  // Only rows that have completed a detail fetch carry a payload (list-only rows
  // have payload=null). Active (non-disappeared) rows only.
  const detailedActive = {
    where: { disappeared_at: null, detail_fetched_at: { not: null } },
    select: { id: true, payload: true, site_id: true },
  } as const;
  const [processedRows, haulRows] = await Promise.all([
    prisma.mymrcProcessedMirror.findMany(detailedActive),
    prisma.mymrcHaulsMirror.findMany(detailedActive),
  ]);

  const toClassifierRow = (r: MirrorRowForFeed): { id: string; payload: unknown } => ({
    id: r.id,
    payload: r.payload,
  });

  const processedCandidates = detectProcessedRecordChanges(
    siteResolvedFirst(processedRows).map(toClassifierRow),
    sources,
    aliases,
  );
  const haulCandidates = detectHaulRecordChanges(
    siteResolvedFirst(haulRows).map(toClassifierRow),
    sources,
    aliases,
  );

  // Cross-feed dedup: one queue row per unknown source name (processed wins ties —
  // its mirror carries the structured Account__c join).
  const merged: ReconciliationCandidate[] = [];
  const seenNames = new Set<string>();
  for (const c of [...processedCandidates, ...haulCandidates]) {
    if (seenNames.has(c.suggested_alias)) continue;
    seenNames.add(c.suggested_alias);
    merged.push(c);
  }

  // Cross-run dedup: never re-queue a name that already has a `new_record → sources`
  // queue row in ANY status. approved → became a `sources` row (the classifier
  // matches it next tick anyway); rejected → Bill's decision persists (don't
  // re-surface hourly); pending/snoozed → don't duplicate the open item.
  const existing = await prisma.mymrcReconciliationQueue.findMany({
    where: { target_table: 'sources', change_kind: 'new_record' },
    select: { mymrc_value: true },
  });
  const alreadyQueued = new Set<string>();
  for (const e of existing) {
    if (typeof e.mymrc_value === 'string') alreadyQueued.add(normalizeSourceName(e.mymrc_value));
  }

  const fresh = merged.filter((c) => !alreadyQueued.has(c.suggested_alias));
  const skippedExisting = merged.length - fresh.length;

  if (fresh.length > 0) {
    await prisma.mymrcReconciliationQueue.createMany({
      data: fresh.map((c) => ({
        mirror_table: c.mirror_table,
        mirror_record_id: c.mirror_record_id,
        target_table: c.target_table,
        target_record_id: c.target_record_id,
        field_name: c.field_name,
        // new_record: mymrc_value is the verbatim name; vision_value stays NULL.
        mymrc_value: c.mymrc_value as Prisma.InputJsonValue,
        change_kind: c.change_kind,
      })),
    });
  }

  log(
    'info',
    `mymrc-reconcile-feed: processed=${processedCandidates.length} hauls=${haulCandidates.length} ` +
      `merged=${merged.length} queued=${fresh.length} skipped_existing=${skippedExisting}`,
  );

  return {
    processedCandidates: processedCandidates.length,
    haulCandidates: haulCandidates.length,
    queued: fresh.length,
    skippedExisting,
  };
}
