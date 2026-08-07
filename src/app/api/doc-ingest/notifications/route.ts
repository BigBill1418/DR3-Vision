// ADR-0067 §3.2 / §A.9 — the Microsoft Graph change-notification endpoint.
//
// ── This route is GENUINELY internet-facing ─────────────────────────────────
// Unlike every `/api/internal/**` cron route, this one CANNOT be loopback-gated:
// Microsoft has to reach it from outside. So the `clientState` secret IS the
// authentication, verified in constant time against a stored SHA-256 hash on
// every single notification. There is no network boundary doing that job here.
//
// ── The validation handshake ────────────────────────────────────────────────
// On subscription creation Graph immediately POSTs `?validationToken=…` and
// requires the token echoed back as `text/plain` within 10 seconds. That request
// carries NO clientState — it cannot, because the subscription does not exist
// yet — so it is answered before any verification, which is per the protocol.
//
// The echo is bounded and sent as `text/plain` deliberately: it is attacker-
// controlled text being reflected, so it must never be interpretable as markup.
//
// ── Responding fast, and what "202" means ───────────────────────────────────
// Graph expects an acknowledgement within seconds or it retries and eventually
// deactivates the subscription. So the delta work is kicked off WITHOUT being
// awaited and the response returns immediately. That is safe precisely because
// the notification is not load-bearing: if this process dies mid-delta, the
// scheduled sweep picks the change up anyway. Push is latency; the sweep is
// correctness (§3.2 D4).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { recordNotificationDelivery, verifyNotification } from '@/lib/doc-ingest/subscriptions';
import { runDocIngestSweep } from '@/lib/doc-ingest/sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Graph's validation tokens are short. A bound stops a giant reflected body. */
const MAX_VALIDATION_TOKEN = 2048;
/** Sanity bound on a notification batch. Graph sends tens, never thousands. */
const MAX_NOTIFICATIONS = 200;

interface ChangeNotification {
  subscriptionId?: unknown;
  clientState?: unknown;
  resource?: unknown;
  changeType?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const validationToken = url.searchParams.get('validationToken');

  // ── Handshake ─────────────────────────────────────────────────────────────
  if (validationToken !== null) {
    if (validationToken.length > MAX_VALIDATION_TOKEN) {
      log.warn({ op: 'doc-ingest-webhook' }, '[doc-ingest] oversized validationToken rejected');
      return new NextResponse('invalid', { status: 400, headers: plainText() });
    }
    log.info({ op: 'doc-ingest-webhook' }, '[doc-ingest] validation handshake answered');
    return new NextResponse(validationToken, { status: 200, headers: plainText() });
  }

  // ── Notification ──────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const value = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const drivesToSweep = new Set<string>();
  let verified = 0;
  let rejected = 0;

  for (const raw of value.slice(0, MAX_NOTIFICATIONS)) {
    const notification = raw as ChangeNotification;
    const subscriptionId =
      typeof notification.subscriptionId === 'string' ? notification.subscriptionId : null;
    const clientState =
      typeof notification.clientState === 'string' ? notification.clientState : null;
    if (!subscriptionId) {
      rejected += 1;
      continue;
    }

    const subscription = await verifyNotification(prisma, subscriptionId, clientState);
    if (!subscription) {
      // Unverifiable is indistinguishable from forged, so it is DROPPED — and
      // dropping it is safe, which is the whole point of the sweep existing.
      rejected += 1;
      continue;
    }

    verified += 1;
    await recordNotificationDelivery(prisma, subscription.id);
    drivesToSweep.add(subscription.drive_id);
  }

  if (rejected > 0) {
    // Logged, never paged: an unverified POST on a public endpoint is background
    // internet noise, and paging on it would be a self-inflicted alert storm.
    log.warn(
      { op: 'doc-ingest-webhook', verified, rejected },
      '[doc-ingest] dropped unverifiable change notifications',
    );
  }

  // Fire-and-forget, exactly as the header explains. `runDocIngestSweep` never
  // throws and always writes its own ledger row, so nothing is lost by not
  // awaiting it — and a `.catch` guards against a stubbed impl that might.
  for (const driveId of drivesToSweep) {
    void runDocIngestSweep(prisma, {
      trigger: 'notification',
      driveId,
      // No reachability scan on the push path (ADR-0080). This runs once per
      // notification — potentially many times a minute while somebody is editing
      // a workbook — and the scan is a whole-tenant search whose answer changes
      // on the timescale of somebody sharing a new document, not on the timescale
      // of a cell edit. The scheduled sweep owns it.
      search: null,
      log: (level, message) => log[level]({ op: 'doc-ingest-sweep', driveId }, message),
    }).catch(() => undefined);
  }

  // 202 regardless of how many were verified: Graph deactivates a subscription
  // that returns errors, and "we rejected your forged payload" is not something
  // to tell an unauthenticated caller anyway.
  return new NextResponse(null, { status: 202 });
}

function plainText(): Record<string, string> {
  return {
    // Reflected, attacker-controlled text — never let a browser treat it as markup.
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
}
