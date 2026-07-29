// ADR-0067 §3.2 D4 — THE DELTA SWEEP.
//
// ════════════════════════════════════════════════════════════════════════════
// This is the most important file in the pipeline, and the reason is worth
// stating plainly rather than leaving in an ADR nobody opens.
//
// A push-only ingester fails SILENTLY. A subscription lapses, a notification is
// dropped, a validation handshake breaks behind a proxy — and nothing errors,
// nothing alarms, nothing looks wrong. The data simply stops moving, and the
// dashboards keep rendering yesterday's numbers with today's confidence.
//
// That is not hypothetical. It is exactly what had MyMRC ingesting NOTHING for
// months while every surface reported success (ADR-0057 D9). §3.2 D4 and the
// DO-NOT list are emphatic for that reason: do NOT build a webhook-only
// ingestion path.
//
// So: PUSH FOR LATENCY, SWEEP FOR CORRECTNESS. This sweep runs on a schedule
// that is INDEPENDENT of webhook health. It does not check whether
// subscriptions exist, it does not skip work because a notification arrived, and
// it does not stop if the push path is completely dead. Every source is
// reconciled from Graph on every run, and a run that fails is itself an alarm —
// which is why the ledger row is written even when the run throws.
// ════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DocIngestDeltaResyncError, docIngestGraph, type DocIngestGraph } from './graph';
import { DocIngestHaltedError, DocIngestNotConnectedError } from './access-token';
import { runDiscovery, sourceKey, type SharedItemSource } from './discovery';
import { ensureSubscriptions } from './subscriptions';
import { ingestSource } from './ingest';
import { classifySourceIfNeeded } from './classification';
import { raiseAnomaly, resolveAnomaly } from './anomalies';
import type { ClassifyDeps } from './classifier';

export type SweepTrigger = 'scheduled' | 'notification' | 'manual';
export type SweepStatus = 'ok' | 'partial' | 'failed' | 'halted' | 'skipped';

export interface SweepResult {
  runId: string;
  status: SweepStatus;
  sourcesDiscovered: number;
  sourcesUpdated: number;
  versionsCreated: number;
  versionsApplied: number;
  versionsStaged: number;
  anomaliesRaised: number;
  subscriptionsRenewed: number;
  error: string | null;
}

export interface RunSweepOptions {
  trigger?: SweepTrigger;
  now?: Date;
  graph?: DocIngestGraph;
  sharedItemSource?: SharedItemSource;
  classifyDeps?: ClassifyDeps;
  /** Restrict ingestion to one drive (the notification-triggered path). */
  driveId?: string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Run one sweep.
 *
 * A ledger row is ALWAYS written, including on throw — the `ap_poll_runs`
 * contract (ADR-0046 C6), for the same reason: without it, "the sweep has not
 * run since Tuesday" is invisible, and invisible is how this class of failure
 * kills you.
 *
 * Never throws. The caller is a cron endpoint, and an exception escaping here
 * would produce a 500 whose only record is a log line nobody reads.
 */
export async function runDocIngestSweep(
  prisma: PrismaClient,
  options: RunSweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? 'scheduled';
  const runId = randomUUID();
  const log = options.log ?? (() => undefined);

  const run = await prisma.docIngestSweepRun.create({
    data: { started_at: now, status: 'failed', trigger, run_id: runId },
  });

  const result: SweepResult = {
    runId,
    status: 'ok',
    sourcesDiscovered: 0,
    sourcesUpdated: 0,
    versionsCreated: 0,
    versionsApplied: 0,
    versionsStaged: 0,
    anomaliesRaised: 0,
    subscriptionsRenewed: 0,
    error: null,
  };

  try {
    const graph = options.graph ?? docIngestGraph(prisma);

    // ── 1. Discover ───────────────────────────────────────────────────────
    // Full enumeration every run — NOT "only when a notification said so".
    // This is what picks up a file added to a shared folder yesterday whose
    // notification never arrived.
    const discovery = await runDiscovery(
      prisma,
      graph,
      options.sharedItemSource ?? { listSharedRoots: () => graph.listSharedWithMe() },
      { now },
    );
    result.sourcesDiscovered = discovery.discovered;
    result.sourcesUpdated = discovery.updated;
    result.anomaliesRaised += discovery.anomaliesRaised;
    log(
      'info',
      `discovery: +${discovery.discovered} new, ${discovery.updated} seen, ${discovery.deduped} deduped`,
    );

    // ── 2. Subscriptions ──────────────────────────────────────────────────
    // Deliberately AFTER discovery and deliberately non-fatal. Push is an
    // optimisation; the ingest below does not consult it and does not care
    // whether it worked.
    try {
      const subs = await ensureSubscriptions(prisma, graph, now);
      result.subscriptionsRenewed = subs.created + subs.renewed;
      if (subs.failed > 0)
        log('warn', `subscriptions: ${subs.failed} failed (sweep still authoritative)`);
    } catch (e) {
      log('warn', `subscription maintenance failed: ${describe(e)} — sweep continues`);
    }

    // ── 3. Delta, per drive ───────────────────────────────────────────────
    // The delta query is what a notification points AT: the notification says
    // that something changed, the delta says what. Running it unconditionally
    // means a dropped notification costs latency, never correctness.
    await runDeltaForDrives(prisma, graph, options.driveId ?? null, now, log);

    // ── 4. Ingest ─────────────────────────────────────────────────────────
    const sources = await prisma.docSource.findMany({
      where: {
        state: 'active',
        enabled: true,
        kind: 'file',
        ...(options.driveId ? { drive_id: options.driveId } : {}),
      },
    });

    for (const source of sources) {
      try {
        // INGEST FIRST, then classify. (Fixed 2026-07-29; ADR-0067 Amendment 4.)
        //
        // The superseded order classified first, justified by the guardrail's
        // condition 4 — "the document no longer parses as its REGISTERED
        // classification". That justification was wrong on its own terms:
        // `classifySourceIfNeeded` only ever writes `proposed_*`, and the
        // guardrail reads `source.doc_class` (ingest.ts:217), which only Bill's
        // confirmation can set. Classifying first bought nothing it claimed to.
        //
        // What it cost was real. `classifySourceIfNeeded` classifies from the
        // latest `doc_source_version.parse_summary`, and `ingestSource` is what
        // CREATES that version — so on a source's first sweep the classifier was
        // handed `summary: null`. Live, on the first real document: TEREX.xlsx
        // was proposed `unknown` (confidence 0.1) with the reasoning "the
        // workbook is completely empty — no sheets, no column headers, no row
        // data, and no content sample", while the stored `parse_summary` for
        // that same file recorded 40 sheets and 2,117 rows. The classifier was
        // not wrong; it accurately described the empty input it was given. A
        // model asked to judge nothing will confidently describe nothing, and it
        // reads as a parser failure when it is a plumbing failure.
        //
        // `classifySourceIfNeeded` now also refuses a file with no version of
        // its own, so this ordering is belt-and-braces rather than the only
        // guard.
        const ingested = await ingestSource(prisma, graph, source, { now });
        await classifySourceIfNeeded(prisma, source, options.classifyDeps ?? {}, now);

        result.anomaliesRaised += ingested.anomaliesRaised;
        if (ingested.outcome === 'applied') {
          result.versionsCreated += 1;
          result.versionsApplied += 1;
        } else if (ingested.outcome === 'staged') {
          result.versionsCreated += 1;
          result.versionsStaged += 1;
        } else if (ingested.outcome === 'failed') {
          result.status = 'partial';
        }
      } catch (e) {
        // One bad document must never stop the other twenty.
        result.status = 'partial';
        log('error', `source ${source.display_name}: ${describe(e)}`);
      }
    }

    await finish(prisma, run.id, result, new Date());
    await resolveAnomaly(prisma, 'sweep_failed', 'sweep', 'A sweep completed successfully.');
    return result;
  } catch (e) {
    // ── Auth failures halt CLEANLY and LOUDLY ─────────────────────────────
    // `acquireAccessToken` has already latched `reauth_required` and paged
    // (Amendment A §A.6). Re-paging here would double-notify for one event, so
    // this records `halted` and stops — it never silently no-ops, and it never
    // retries into the void.
    if (e instanceof DocIngestHaltedError || e instanceof DocIngestNotConnectedError) {
      result.status = 'halted';
      result.error = e.message;
      await finish(prisma, run.id, result, new Date());
      log('warn', `sweep halted: ${e.message}`);
      return result;
    }

    result.status = 'failed';
    result.error = describe(e);
    await finish(prisma, run.id, result, new Date());

    // The sweep IS the correctness guarantee. A sweep that stops working while
    // everything else looks healthy is the exact shape of the failure this
    // design exists to prevent, so it pages.
    await raiseAnomaly(prisma, {
      kind: 'sweep_failed',
      subject: 'sweep',
      detail:
        `The document-ingestion delta sweep failed: ${result.error}. ` +
        `Shared documents are NOT being reconciled — anything that changed since the last successful sweep ` +
        `is not reflected in Vision. Push notifications do not cover this: the sweep is the correctness path.`,
      context: { runId, trigger },
      now,
    }).catch(() => undefined);

    log('error', `sweep failed: ${result.error}`);
    return result;
  }
}

/**
 * Replay each drive's delta token.
 *
 * The delta result is used to REFRESH the source rows' content markers, not to
 * decide what to ingest — ingestion is driven off `doc_sources.ctag` afterwards.
 * Keeping those separate is what makes the sweep idempotent: replaying a delta
 * twice changes nothing, because the ctag comparison in `ingestSource` is the
 * only thing that ever triggers work.
 */
async function runDeltaForDrives(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  onlyDriveId: string | null,
  now: Date,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<void> {
  const subscriptions = await prisma.docIngestSubscription.findMany({
    where: {
      state: { in: ['pending', 'active', 'failed', 'expired'] },
      ...(onlyDriveId ? { drive_id: onlyDriveId } : {}),
    },
  });

  for (const subscription of subscriptions) {
    try {
      const page = await graph.deltaForDrive(subscription.drive_id, subscription.delta_link);
      await applyDeltaItems(prisma, page.items, now);
      await prisma.docIngestSubscription.update({
        where: { id: subscription.id },
        data: { delta_link: page.deltaLink, delta_synced_at: now },
      });
    } catch (e) {
      if (e instanceof DocIngestDeltaResyncError) {
        // Graph expired the token. A full re-enumeration follows on the next
        // pass — NEVER a silent skip, because a skipped delta window is a change
        // that is missed permanently rather than late.
        await prisma.docIngestSubscription.update({
          where: { id: subscription.id },
          data: { delta_link: null },
        });
        await raiseAnomaly(prisma, {
          kind: 'delta_token_invalid',
          subject: `drive:${subscription.drive_id}`,
          subscriptionId: subscription.id,
          detail:
            `The change-tracking token for drive ${subscription.drive_id} expired. It has been reset and the next ` +
            `sweep re-enumerates the drive in full, so nothing is lost — only this run's incremental read.`,
          now,
        });
        continue;
      }
      // Delta is an optimisation over full discovery, which already ran above.
      // A failure here therefore costs nothing that matters this run.
      log('warn', `delta for drive ${subscription.drive_id} failed: ${describe(e)}`);
    }
  }
}

/**
 * Fold delta results into the source rows.
 *
 * Only sources Vision ALREADY tracks are touched. A drive's delta reports every
 * item in it, including files nobody shared with the service account — creating
 * sources from that would silently widen the watched set far past what anyone
 * consented to share, which is the opposite of D1.
 */
async function applyDeltaItems(
  prisma: PrismaClient,
  items: {
    id: string;
    driveId: string;
    ctag: string | null;
    etag: string | null;
    name: string;
    deleted: boolean;
    lastModifiedAt: string | null;
  }[],
  now: Date,
): Promise<void> {
  for (const item of items) {
    const existing = await prisma.docSource.findUnique({
      where: { drive_id_item_id: { drive_id: item.driveId, item_id: item.id } },
      select: { id: true, state: true },
    });
    if (!existing) continue;

    if (item.deleted) {
      if (existing.state === 'active') {
        await prisma.docSource.update({
          where: { id: existing.id },
          data: { state: 'disappeared', disappeared_at: now },
        });
        await raiseAnomaly(prisma, {
          kind: 'source_disappeared',
          subject: sourceKey(item.driveId, item.id),
          docSourceId: existing.id,
          detail: `"${item.name}" was deleted in Microsoft. Its last known state and version history are retained.`,
          now,
        });
      }
      continue;
    }

    await prisma.docSource.update({
      where: { id: existing.id },
      data: {
        ctag: item.ctag,
        etag: item.etag,
        display_name: item.name,
        last_modified_at: item.lastModifiedAt ? new Date(item.lastModifiedAt) : null,
        last_seen_at: now,
      },
    });
  }
}

async function finish(
  prisma: PrismaClient,
  runRowId: string,
  result: SweepResult,
  finishedAt: Date,
): Promise<void> {
  await prisma.docIngestSweepRun.update({
    where: { id: runRowId },
    data: {
      finished_at: finishedAt,
      status: result.status,
      sources_discovered: result.sourcesDiscovered,
      sources_updated: result.sourcesUpdated,
      versions_created: result.versionsCreated,
      versions_applied: result.versionsApplied,
      versions_staged: result.versionsStaged,
      anomalies_raised: result.anomaliesRaised,
      subscriptions_renewed: result.subscriptionsRenewed,
      error: result.error,
    },
  });
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
