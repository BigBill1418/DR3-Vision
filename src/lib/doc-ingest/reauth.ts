// ADR-0067 Amendment A §A.6 — the `reauth_required` posture.
//
// Bill's instruction, verbatim in shape: any refresh failure attributable to an
// invalidated or expired token PAGES `dr3-vision-system` IMMEDIATELY (the
// ADR-0057 D9 posture — silence is never acceptable), raises a banner with a
// reconnect action, adds a line to the 06:00 digest until resolved, and HALTS
// ingestion loudly rather than degrading quietly.
//
// ── Why the latch lives in Postgres, not in the ntfy helper ─────────────────
// `publishNtfy`'s cooldown ledger is per-process and per-container. Ingestion
// will run across the app AND a worker, and containers restart. A per-process
// cooldown would either re-page on every restart or, worse, suppress the FIRST
// page after a restart. The DB column `reauth_paged_at` is the one ledger every
// process shares, so `cooldownMs: 0` is passed deliberately — this module owns
// the dedup, and the in-process ledger must not second-guess it.
//
// ── What does NOT latch ─────────────────────────────────────────────────────
// Only `DocIngestReauthRequiredError` latches. A network blip, a 429, a 5xx are
// transient: they are recorded in `last_refresh_error` and retried. Latching on
// a blip would page Bill for a hiccup and teach him to ignore the page, which
// costs more than the blip ever would.

import type { PrismaClient } from '@prisma/client';
import { publishNtfy } from '@/lib/ntfy';
import { SINGLETON_ID } from './connection-store';
import { DOC_INGEST_SERVICE_UPN } from './config';

/** Where the operator goes to fix it. Tier-1 click target per ADR-0036. */
export const CONNECT_PAGE_PATH = '/admin/doc-ingest/connect';

/** ntfy topic. System-level only, per CLAUDE.md hard rule #5. */
const NTFY_TOPIC = 'dr3-vision-system';

/**
 * How often the UNRESOLVED state re-pages. The transition always pages
 * immediately; this only bounds the reminder. 24 h matches ADR-0037's
 * "periodic X is not OK" band — the 06:00 digest line carries the rest, so a
 * shorter interval would be noise on top of a signal Bill already gets daily.
 */
export const REPAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function connectUrl(): string {
  const base = process.env['NEXTAUTH_URL']?.trim() || 'https://dr3-vision.svdp.us';
  return `${base.replace(/\/+$/, '')}${CONNECT_PAGE_PATH}`;
}

export interface LatchResult {
  /** True when this call moved the connection from `connected` to `reauth_required`. */
  transitioned: boolean;
  /** True when an ntfy page was actually attempted. */
  paged: boolean;
}

/**
 * Latch `reauth_required` and page. Idempotent: safe to call on every failed
 * refresh. Pages on the TRANSITION and then at most once per
 * {@link REPAGE_INTERVAL_MS} while the state persists.
 *
 * Returns `{ transitioned: false, paged: false }` when no connection row exists
 * — there is nothing to re-authenticate, and paging "reconnect the thing you
 * never connected" would be a false alarm on a fresh install.
 */
export async function latchReauthRequired(
  prisma: PrismaClient,
  reason: string,
  now: Date = new Date(),
): Promise<LatchResult> {
  const row = await prisma.docIngestConnection.findUnique({
    where: { id: SINGLETON_ID },
    select: { state: true, reauth_paged_at: true, account_upn: true },
  });
  if (!row) return { transitioned: false, paged: false };

  const transitioned = row.state !== 'reauth_required';
  const dueForRepage =
    row.reauth_paged_at === null ||
    now.getTime() - row.reauth_paged_at.getTime() >= REPAGE_INTERVAL_MS;
  const shouldPage = transitioned || dueForRepage;

  await prisma.docIngestConnection.update({
    where: { id: SINGLETON_ID },
    data: {
      state: 'reauth_required',
      reauth_reason: reason,
      // Preserve the ORIGINAL onset across repeated calls — "since when" is the
      // number that tells Bill whether this is new or has been rotting.
      ...(transitioned ? { reauth_since: now } : {}),
      last_refresh_error: reason,
      ...(shouldPage ? { reauth_paged_at: now } : {}),
    },
  });

  if (!shouldPage) return { transitioned, paged: false };

  await publishNtfy({
    topic: NTFY_TOPIC,
    title: 'Document ingestion disconnected — sign-in required',
    body: `The delegated Microsoft connection for ${row.account_upn} can no longer refresh: ${reason}. Document ingestion is HALTED until someone signs in again as ${DOC_INGEST_SERVICE_UPN} at ${CONNECT_PAGE_PATH}.`,
    priority: 'high',
    tags: ['warning', 'doc-ingest', 'auth', 'dr3-vision'],
    clickUrl: connectUrl(),
    // This module owns dedup via `reauth_paged_at` (see header). The in-process
    // ledger must not also suppress, or a container restart changes behaviour.
    cooldownMs: 0,
  });

  return { transitioned, paged: true };
}

/**
 * Record a TRANSIENT refresh failure without latching. Keeps the operator
 * surface honest ("last refresh failed, still retrying") while refusing to
 * escalate a blip into a human-action page.
 */
export async function recordTransientRefreshFailure(
  prisma: PrismaClient,
  reason: string,
): Promise<void> {
  await prisma.docIngestConnection.updateMany({
    where: { id: SINGLETON_ID },
    data: { last_refresh_error: reason },
  });
}

/**
 * One line for Bill's 06:00 digest, or null when there is nothing to say.
 *
 * Deliberately a WARNING line rather than a whole ingestion digest: the AP
 * digest module reserves a future ingestion digest for itself (ADR-0066 §1.7),
 * and this is a system-health warning, not a work queue. It also rides the AP
 * digest's existing rule that a warning sends even when the queue is empty —
 * which is exactly right here, because a disconnected ingester produces no
 * items and would otherwise be invisible precisely when it is broken.
 */
export async function docIngestReauthWarning(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<string | null> {
  const row = await prisma.docIngestConnection.findUnique({
    where: { id: SINGLETON_ID },
    select: { state: true, reauth_since: true, reauth_reason: true, account_upn: true },
  });
  if (!row || row.state !== 'reauth_required') return null;

  const days = row.reauth_since
    ? Math.max(0, Math.floor((now.getTime() - row.reauth_since.getTime()) / 86_400_000))
    : null;
  const since = days === null ? '' : days === 0 ? ' (since today)' : ` (${days}d)`;
  const why = row.reauth_reason ? ` — ${row.reauth_reason}` : '';
  return `Document ingestion is DISCONNECTED${since}${why}. Nothing is being pulled from shared files. Sign in again as ${DOC_INGEST_SERVICE_UPN} at ${CONNECT_PAGE_PATH}.`;
}
