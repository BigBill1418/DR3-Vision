// ADR-0067 §3.2 — Graph change-notification subscriptions.
//
// ── What a notification is and is not ───────────────────────────────────────
// A Graph change notification says THAT something in a drive changed. It does
// not say what. So every notification is followed by a DELTA QUERY, which is
// where the actual change is found. Treating the notification payload as the
// change is the classic mistake and produces an ingester that misses everything
// batched into one notification.
//
// ── Push is for LATENCY. The sweep is for CORRECTNESS. ──────────────────────
// Nothing in this file is load-bearing for correctness. Subscriptions lapse,
// notifications get dropped, validation handshakes fail behind a proxy — and a
// push-only design fails SILENTLY when any of that happens. That is exactly the
// failure mode that had MyMRC ingesting nothing for months (ADR-0057 D9).
// §3.2 D4 is explicit: do NOT build a webhook-only ingestion path. So every
// failure here degrades to "slower", never to "wrong", because `sweep.ts` runs
// on its own schedule regardless of anything below.
//
// ── clientState ─────────────────────────────────────────────────────────────
// The notification endpoint is genuinely internet-facing (Graph must reach it),
// so the `clientState` secret IS the authentication. It is minted per
// subscription, stored ONLY as a SHA-256 hash, and compared in constant time on
// every inbound notification. Storing the plaintext would put a
// bearer-equivalent value in every database backup for no gain.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient, DocIngestSubscription } from '@prisma/client';
import { DocIngestAccessDeniedError, type DocIngestGraph } from './graph';
import {
  DOC_INGEST_RENEW_LEAD_MS,
  docIngestNotificationUrl,
  docIngestSubscriptionTtlMinutes,
} from './pipeline-config';
import { raiseAnomaly, resolveAnomaly } from './anomalies';

/**
 * The Graph resource we subscribe to.
 *
 * Verified against learn.microsoft.com/graph/change-notifications-overview: for
 * OneDrive for work or school the ONLY supported driveItem resource path is
 * `/drives/{id}/root`, and it covers "changes to content within the hierarchy of
 * the root folder". There is no per-item subscription — which is convenient
 * here, because a folder subscription therefore covers files added to it later.
 */
export function driveSubscriptionResource(driveId: string): string {
  return `/drives/${driveId}/root`;
}

/**
 * ⚠ Why a 403 here is STRUCTURAL, not a missing permission.
 *
 * CORRECTED 2026-07-29 (ADR-0067 Amendment 4). This note previously said
 * Microsoft requires delegated **Files.ReadWrite.All** to create a driveItem
 * subscription, and therefore invited Bill to trade tenant-wide WRITE access for
 * lower latency. That was wrong, and it was the more dangerous kind of wrong: it
 * recommended a permanent security concession to fix something the concession
 * would not have fixed.
 *
 * learn.microsoft.com/graph/api/subscription-post-subscriptions lists, for
 * `driveItem` (OneDrive for Business), delegated **Files.Read.All** — with no
 * higher-privileged alternative offered at all — and states plainly: "Due to
 * security restrictions, Microsoft Graph subscriptions don't support write access
 * permissions when only read access permissions are needed." This integration
 * already holds exactly that permission. `GET /subscriptions` returns 200, so the
 * token is accepted; the refusal is not a blanket scope rejection.
 *
 * The real blocker is the RESOURCE. The same page: "On OneDrive for Business, you
 * can subscribe to only the root folder… You can't subscribe to drive or
 * driveItem instances that aren't folders, such as individual files." The service
 * account reaches these documents through ITEM-LEVEL shares — it has no effective
 * permission on any drive root, and there is no legal per-file subscription
 * target. So there is nothing to subscribe to, at any permission level.
 *
 * Consequence: push notifications are unavailable for item-level shares by
 * design, the scheduled delta sweep is the mechanism rather than a fallback, and
 * §3.2 D4 holds by construction. There is no permission grant that changes this
 * and none should be offered.
 */
export const SUBSCRIPTION_SCOPE_NOTE =
  'This is a STRUCTURAL limit of Microsoft Graph, not a missing permission — and it is NOT fixable by ' +
  'granting a broader scope. Vision already holds the exact permission Microsoft documents for driveItem ' +
  'subscriptions on OneDrive for Business (delegated Files.Read.All); Microsoft explicitly does not accept ' +
  'write permissions where read permissions suffice. The blocker is the target: on OneDrive for Business a ' +
  'subscription may only be created on a DRIVE ROOT, never on an individual file, and Vision reaches these ' +
  'documents through item-level shares — it has no permission on the drive root, so there is no legal ' +
  'subscription target. Push notifications are therefore unavailable for individually-shared files. Document ' +
  'changes are picked up by the scheduled delta sweep instead: correctness is unaffected, latency is one ' +
  'sweep interval instead of about a minute. Do not grant Files.ReadWrite.All to "fix" this — it would ' +
  'buy tenant-wide write access and change nothing.';

/**
 * Backoff for a drive whose subscription attempt failed.
 *
 * A refusal here is usually PERMANENT (see SUBSCRIPTION_SCOPE_NOTE), so retrying
 * every sweep is a guaranteed-403 hammered at Graph 96 times a day forever. Back
 * off exponentially from one sweep interval to a day, and keep retrying at that
 * cadence so the day the share becomes a drive-root grant, push starts working
 * with no code change and no operator action.
 */
export function subscriptionRetryDelayMs(failureCount: number): number {
  const base = 15 * 60_000;
  const day = 24 * 60 * 60_000;
  const exp = Math.min(Math.max(failureCount, 1) - 1, 10);
  return Math.min(base * 2 ** exp, day);
}

export function hashClientState(clientState: string): string {
  return createHash('sha256').update(clientState, 'utf8').digest('hex');
}

/** Constant-time hex-digest comparison. Length-safe. */
export function clientStateMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashClientState(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Mint a clientState.
 *
 * Only the HASH is persisted. Graph's renewal PATCH carries `expirationDateTime`
 * alone — verified against learn.microsoft.com/graph/api/subscription-update —
 * so nothing ever needs the plaintext back. Keeping a recoverable copy would
 * store a bearer-equivalent secret for a use case that does not exist.
 */
export function mintClientState(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString('base64url');
  return { plaintext, hash: hashClientState(plaintext) };
}

export interface EnsureSubscriptionsResult {
  created: number;
  renewed: number;
  failed: number;
  /** Subscriptions whose validation handshake Graph rejected (§A.9). */
  validationFailures: number;
}

/**
 * Bring subscriptions in line with the drives Vision is actually watching:
 * create one per distinct drive, renew any nearing expiry, and record every
 * failure loudly.
 *
 * NEVER throws for a per-drive failure. One tenant refusing a subscription must
 * not stop the other drives from being subscribed, and must not stop the sweep
 * that follows.
 */
export async function ensureSubscriptions(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  now: Date = new Date(),
): Promise<EnsureSubscriptionsResult> {
  const result: EnsureSubscriptionsResult = {
    created: 0,
    renewed: 0,
    failed: 0,
    validationFailures: 0,
  };

  const drives = await prisma.docSource.findMany({
    where: { state: 'active', enabled: true },
    select: { drive_id: true },
    distinct: ['drive_id'],
  });

  const notificationUrl = docIngestNotificationUrl();
  const ttlMs = docIngestSubscriptionTtlMinutes() * 60_000;

  for (const { drive_id: driveId } of drives) {
    // ── One row per drive, ALWAYS ────────────────────────────────────────────
    // This used to match only `pending`/`active`, so a `failed` row matched
    // nothing and `createSubscription` INSERTED A FRESH ROW every sweep — 96
    // rows/drive/day, unbounded. Worse, `sweep.ts` runs a delta pass per row in
    // ('pending','active','failed','expired'), so Graph call volume grew
    // linearly with uptime. Found live with 2 rows for one drive after 2 sweeps.
    // Match ANY state and reuse the row.
    const existing =
      (await prisma.docIngestSubscription.findFirst({
        where: { drive_id: driveId, state: { in: ['pending', 'active'] } },
        orderBy: { created_at: 'desc' },
      })) ??
      (await prisma.docIngestSubscription.findFirst({
        where: { drive_id: driveId },
        orderBy: { created_at: 'desc' },
      }));

    if (!existing) {
      await createSubscription(prisma, graph, driveId, notificationUrl, ttlMs, now, result);
      continue;
    }

    // A row we already know is dead: retry into the SAME row, on a backoff, so a
    // permanent refusal costs one Graph call a day instead of one every sweep.
    if (existing.state === 'failed' || existing.state === 'expired') {
      const dueAt = existing.renew_after ?? existing.updated_at;
      if (dueAt.getTime() > now.getTime()) continue;
      await createSubscription(
        prisma,
        graph,
        driveId,
        notificationUrl,
        ttlMs,
        now,
        result,
        existing,
      );
      continue;
    }

    const dueForRenewal =
      existing.expires_at === null ||
      existing.expires_at.getTime() - now.getTime() <= DOC_INGEST_RENEW_LEAD_MS;
    if (!dueForRenewal) continue;

    await renewOrRecreate(prisma, graph, existing, driveId, notificationUrl, ttlMs, now, result);
  }

  // Expire the bookkeeping for drives we no longer watch, so the health surface
  // does not report subscriptions for documents nobody shares any more.
  await expireOrphaned(prisma, graph, new Set(drives.map((d) => d.drive_id)), now);

  return result;
}

async function createSubscription(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  driveId: string,
  notificationUrl: string,
  ttlMs: number,
  now: Date,
  result: EnsureSubscriptionsResult,
  /**
   * A dead row for this drive to RETRY INTO. Supplying it is what keeps the
   * table at one row per drive; without it every failed attempt left a permanent
   * row behind and the next sweep added another.
   */
  reuse?: DocIngestSubscription,
): Promise<void> {
  const resource = driveSubscriptionResource(driveId);
  const { plaintext, hash } = mintClientState();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // The row is written BEFORE the Graph call, in `pending`, carrying the
  // clientState HASH. Graph's validation POST can arrive before its own HTTP
  // response reaches us, and a notification whose hash is not yet stored would
  // be unverifiable and dropped. Writing first closes that window.
  //
  // `delta_link` is deliberately PRESERVED on a retry: it is the sweep's cursor
  // into this drive, it is valid independently of whether push works, and
  // clearing it would force a full re-enumeration on every failed handshake.
  const row = reuse
    ? await prisma.docIngestSubscription.update({
        where: { id: reuse.id },
        data: {
          resource,
          notification_url: notificationUrl,
          client_state_hash: hash,
          subscription_id: null,
          expires_at: null,
          renew_after: null,
          state: 'pending',
        },
      })
    : await prisma.docIngestSubscription.create({
        data: {
          drive_id: driveId,
          resource,
          notification_url: notificationUrl,
          client_state_hash: hash,
          delta_link: null,
          state: 'pending',
        },
      });

  try {
    const created = await graph.createSubscription({
      resource,
      notificationUrl,
      clientState: plaintext,
      expiresAt,
    });
    await prisma.docIngestSubscription.update({
      where: { id: row.id },
      data: {
        subscription_id: created.id,
        expires_at: new Date(created.expirationDateTime),
        last_renewed_at: now,
        renew_after: new Date(
          new Date(created.expirationDateTime).getTime() - DOC_INGEST_RENEW_LEAD_MS,
        ),
        state: 'active',
        failure_count: 0,
        last_error: null,
        // Graph only issues a subscription id AFTER our endpoint echoed its
        // validationToken, so a successful create IS the empirical proof that
        // the handshake worked (§A.9).
        validated_at: now,
      },
    });
    await resolveAnomaly(
      prisma,
      'webhook_validation_failed',
      `drive:${driveId}`,
      'Subscription created — validation handshake succeeded.',
    );
    await resolveAnomaly(
      prisma,
      'subscription_renew_failed',
      `drive:${driveId}`,
      'Subscription recreated.',
    );
    result.created += 1;
  } catch (e) {
    const reason = describe(e);
    const failureCount = row.failure_count + 1;
    await prisma.docIngestSubscription.update({
      where: { id: row.id },
      data: {
        state: 'failed',
        failure_count: failureCount,
        last_error: reason,
        // The retry clock. Without it the next sweep repeats a refusal that is
        // usually permanent, 96 times a day, forever.
        renew_after: new Date(now.getTime() + subscriptionRetryDelayMs(failureCount)),
      },
    });
    result.failed += 1;

    // §A.9 — a failed handshake must NEVER silently fall back to polling-only.
    // The sweep does cover correctness, so this is not a data emergency; but
    // latency degrades from "about a minute" to "one sweep interval", and the
    // operator has to be told which of those they are living with.
    const isValidation = /validation|validationToken|subscriptionValidation/i.test(reason);
    if (isValidation) result.validationFailures += 1;
    // A 403 here is the EXPECTED outcome for an item-level share, not a bug —
    // see SUBSCRIPTION_SCOPE_NOTE. Say so plainly, or the operator will hunt a
    // misconfiguration that does not exist.
    //
    // Detected by TYPE, not by string. The regex it replaces matched `403`,
    // `forbidden` or `accessDenied` against `DocIngestAccessDeniedError.message`,
    // which reads "access denied for POST /subscriptions" — no status code, no
    // "forbidden", and `accessDenied` ≠ `access denied` because of the space. It
    // could never match the one error it was written for, so `scopeRelated` was
    // always false and this explanation was never shown. (Two bugs cancelling:
    // had it matched, it would have shown the WRONG explanation — see the note.)
    const isScope = e instanceof DocIngestAccessDeniedError || /\b403\b|forbidden/i.test(reason);
    await raiseAnomaly(prisma, {
      kind: isValidation ? 'webhook_validation_failed' : 'subscription_renew_failed',
      subject: `drive:${driveId}`,
      subscriptionId: row.id,
      detail: isValidation
        ? `Microsoft could not validate the change-notification endpoint ${notificationUrl} for drive ${driveId}: ${reason}. ` +
          `Vision has NOT silently fallen back to polling-only — the scheduled delta sweep still keeps every document correct, ` +
          `but changes are now picked up on the sweep interval instead of within about a minute.`
        : isScope
          ? `Microsoft refused a change subscription for drive ${driveId} (${reason}). ${SUBSCRIPTION_SCOPE_NOTE}`
          : `Could not create a change subscription for drive ${driveId}: ${reason}. ` +
            `The scheduled delta sweep still keeps documents correct; only latency is affected.`,
      context: { driveId, notificationUrl, scopeRelated: isScope },
      // ADR-0098 §2 — the scope refusal is a health tile, not a page. It is the
      // EXPECTED outcome for an item-level share (SUBSCRIPTION_SCOPE_NOTE), it
      // is not fixable, and it re-paged every 24h forever. A validation failure
      // or any other refusal still pages: those are actionable.
      dashboardOnly: isScope,
      now,
    });
  }
}

async function renewOrRecreate(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  existing: DocIngestSubscription,
  driveId: string,
  notificationUrl: string,
  ttlMs: number,
  now: Date,
  result: EnsureSubscriptionsResult,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + ttlMs);

  // No Graph id yet (a create that never completed) — there is nothing to renew.
  // Retry INTO the same row rather than abandoning it and inserting another.
  if (!existing.subscription_id) {
    await createSubscription(prisma, graph, driveId, notificationUrl, ttlMs, now, result, existing);
    return;
  }

  try {
    const renewed = await graph.renewSubscription(existing.subscription_id, expiresAt);
    const newExpiry = new Date(renewed.expirationDateTime);
    await prisma.docIngestSubscription.update({
      where: { id: existing.id },
      data: {
        expires_at: newExpiry,
        last_renewed_at: now,
        renew_after: new Date(newExpiry.getTime() - DOC_INGEST_RENEW_LEAD_MS),
        state: 'active',
        failure_count: 0,
      },
    });
    await resolveAnomaly(
      prisma,
      'subscription_renew_failed',
      `drive:${driveId}`,
      'Subscription renewed.',
    );
    await resolveAnomaly(
      prisma,
      'subscription_expired',
      `drive:${driveId}`,
      'Subscription renewed.',
    );
    result.renewed += 1;
  } catch (e) {
    const reason = describe(e);
    const failureCount = existing.failure_count + 1;
    await prisma.docIngestSubscription.update({
      where: { id: existing.id },
      data: {
        state: 'failed',
        failure_count: failureCount,
        last_error: reason,
        renew_after: new Date(now.getTime() + subscriptionRetryDelayMs(failureCount)),
      },
    });
    result.failed += 1;
    await raiseAnomaly(prisma, {
      kind: 'subscription_renew_failed',
      subject: `drive:${driveId}`,
      subscriptionId: existing.id,
      detail:
        `Could not renew the change subscription for drive ${driveId}: ${reason}. ` +
        `Push notifications will lapse${
          existing.expires_at ? ` at ${existing.expires_at.toISOString()}` : ''
        }. The scheduled delta sweep continues to keep documents correct — only latency degrades.`,
      context: { driveId, subscriptionId: existing.subscription_id },
      now,
    });

    // A renew that failed because the subscription is already gone is not a
    // dead end: drop the record so the next pass creates a fresh one instead of
    // retrying a PATCH against something that no longer exists.
    if (/404|not ?found/i.test(reason)) {
      await prisma.docIngestSubscription.update({
        // `renew_after` is cleared so the next sweep recreates immediately: the
        // subscription is simply gone, which is a recoverable condition, not the
        // permanent refusal the backoff exists for.
        where: { id: existing.id },
        data: { state: 'expired', subscription_id: null, renew_after: null },
      });
    }
  }
}

/** Tear down subscriptions for drives nothing is shared from any more. */
async function expireOrphaned(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  liveDriveIds: Set<string>,
  now: Date,
): Promise<void> {
  const rows = await prisma.docIngestSubscription.findMany({
    // `failed`/`expired` rows are included: now that one row per drive is reused
    // rather than replaced, a dead row for a drive nobody shares from any more
    // would otherwise sit here forever, and `sweep.ts` runs a delta pass for it
    // on every cycle.
    where: { state: { in: ['pending', 'active', 'failed', 'expired'] } },
    select: { id: true, drive_id: true, subscription_id: true },
  });
  for (const row of rows) {
    if (liveDriveIds.has(row.drive_id)) continue;
    if (row.subscription_id) {
      // Best-effort: a failed delete just leaves a subscription that expires on
      // its own. Never let cleanup break the sweep.
      await graph.deleteSubscription(row.subscription_id).catch(() => undefined);
    }
    await prisma.docIngestSubscription.update({
      where: { id: row.id },
      data: { state: 'revoked', last_renewed_at: now },
    });
  }
}

/**
 * Verify an inbound notification's clientState against the subscription Graph
 * says it came from.
 *
 * Returns the subscription row on success and null on ANY mismatch — unknown
 * subscription id, absent stored hash, wrong secret. Null means "drop it": an
 * unverifiable notification is indistinguishable from a forged one, and the
 * sweep will find the change anyway.
 */
export async function verifyNotification(
  prisma: PrismaClient,
  subscriptionId: string,
  clientState: string | null,
): Promise<DocIngestSubscription | null> {
  if (!clientState) return null;
  const row = await prisma.docIngestSubscription.findFirst({
    where: { subscription_id: subscriptionId },
  });
  if (!row?.client_state_hash) return null;
  return clientStateMatches(clientState, row.client_state_hash) ? row : null;
}

/** Record a verified delivery. This is the only honest measure that push works. */
export async function recordNotificationDelivery(
  prisma: PrismaClient,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.docIngestSubscription.update({
    where: { id },
    data: { last_notification_at: now, notifications_received: { increment: 1 } },
  });
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
