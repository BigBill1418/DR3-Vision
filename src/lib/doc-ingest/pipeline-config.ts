// ADR-0067 §3.2 D4–D8 — tunables for the ingestion pipeline.
//
// Every value is read at CALL TIME, never at module load, matching the fleet
// convention (`src/lib/r2.ts`, `src/lib/ap/extraction/config.ts`): the value
// tracks env set after import and stays unit-testable. Every one has a safe
// default, so the app boots with nothing provisioned.
//
// The defaults here are the SPEC defaults. Where the directive named a number
// ($50 / 15% / 10%), the number is not re-declared — it is imported from the
// module that already owns it, so there is exactly one definition in the system.

import { VARIANCE_FLAT_THRESHOLD_CENTS, VARIANCE_PERCENT_THRESHOLD } from '@/lib/ap/variance';

/**
 * D7 aggregate-variance thresholds. DELIBERATELY re-exported from the AP
 * Amendment 5 (D-M5-4) module rather than redefined.
 *
 * The directive is explicit that there must be ONE anomaly concept in the
 * system, not two. If these were separate constants they would drift the first
 * time somebody tuned one of them, and the system would then hold two different
 * opinions about what "an abnormal change" means — which is worse than either
 * threshold being wrong, because nobody would know which one applied.
 */
export { VARIANCE_FLAT_THRESHOLD_CENTS, VARIANCE_PERCENT_THRESHOLD };

/**
 * How deep to walk inside a shared FOLDER. A shared folder must pick up files
 * added later (that is the whole reason folder-sharing is worth anything), but
 * an unbounded walk on a deeply-nested library is an unbounded number of Graph
 * calls per sweep.
 *
 * 5 is the default because it covers the realistic shape (`Daily Logs / 2026 /
 * 07 / Eugene / file.xlsm`) with a level to spare. Hitting the limit is NEVER
 * silent — it raises `depth_limit_reached`, because "there are files below here
 * that Vision is not watching" is precisely the thing that must not be quiet.
 */
export const DOC_INGEST_MAX_DEPTH_DEFAULT = 5;

export function docIngestMaxDepth(): number {
  return positiveIntEnv('DOC_INGEST_MAX_DEPTH', DOC_INGEST_MAX_DEPTH_DEFAULT);
}

/**
 * Hard cap on a single file's bytes. Exceeding it PAGES rather than silently
 * truncating — a truncated workbook parses fine and produces wrong numbers,
 * which is the worst possible failure mode for a billing input.
 *
 * 100 MB matches the `/admin/file-drop` per-file ceiling, so an operator never
 * has to hold two different size rules in their head.
 */
export const DOC_INGEST_MAX_FILE_BYTES_DEFAULT = 100 * 1024 * 1024;

export function docIngestMaxFileBytes(): number {
  return positiveIntEnv('DOC_INGEST_MAX_FILE_BYTES', DOC_INGEST_MAX_FILE_BYTES_DEFAULT);
}

/**
 * D7 row-drop threshold: the share of rows a revision may lose before it stages
 * instead of auto-applying. Spec default 10%.
 */
export const DOC_INGEST_ROW_DROP_THRESHOLD_DEFAULT = 0.1;

export function docIngestRowDropThreshold(): number {
  const raw = process.env['DOC_INGEST_ROW_DROP_THRESHOLD'];
  const parsed = raw !== undefined ? Number.parseFloat(raw) : Number.NaN;
  // A threshold of exactly 0 is a legitimate tightening ("any row loss stages"),
  // so the guard rejects only NaN / negative / >1, never a deliberate 0.
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DOC_INGEST_ROW_DROP_THRESHOLD_DEFAULT;
}

/**
 * Requested subscription lifetime, in minutes.
 *
 * Microsoft's documented MAXIMUM for a OneDrive `driveItem` subscription is
 * 42,300 minutes (under 30 days) — verified against
 * learn.microsoft.com/graph/change-notifications-overview. We deliberately ask
 * for far less than the maximum: a 7-day lifetime means the renewal path runs
 * every week rather than monthly, so a broken renewal is discovered in days
 * instead of being discovered by its own expiry.
 */
export const DOC_INGEST_SUBSCRIPTION_TTL_MINUTES_DEFAULT = 7 * 24 * 60;

/** Microsoft's hard maximum for a driveItem subscription. Requests are clamped. */
export const DOC_INGEST_SUBSCRIPTION_TTL_MAX_MINUTES = 42_300;

export function docIngestSubscriptionTtlMinutes(): number {
  const requested = positiveIntEnv(
    'DOC_INGEST_SUBSCRIPTION_TTL_MINUTES',
    DOC_INGEST_SUBSCRIPTION_TTL_MINUTES_DEFAULT,
  );
  return Math.min(requested, DOC_INGEST_SUBSCRIPTION_TTL_MAX_MINUTES);
}

/**
 * How long BEFORE expiry a subscription is renewed. Renewing at the last moment
 * means one failed renewal is an outage; renewing a day early means a failed
 * renewal has a whole day of retries before push actually lapses — and the
 * sweep covers the gap either way.
 */
export const DOC_INGEST_RENEW_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * How stale the sweep ledger may get before the health surface calls it broken.
 *
 * This is the deadman. §3.2 D4 exists because a push-only design fails SILENTLY,
 * and the sweep is the answer — but only if a sweep that stops running is itself
 * noticed. MyMRC ingested nothing for months (ADR-0057 D9) precisely because
 * nothing watched the watcher.
 */
export const DOC_INGEST_SWEEP_STALE_MS = 6 * 60 * 60 * 1000;

/** Per-Graph-request timeout. Downloads get their own, longer budget. */
export const DOC_INGEST_REQUEST_TIMEOUT_MS = 30_000;
export const DOC_INGEST_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Pagination guard — bounds any `@odata.nextLink` / delta loop. */
export const DOC_INGEST_MAX_PAGES = 200;

/**
 * The public URL Graph posts change notifications to. Derived from
 * `NEXTAUTH_URL` (as `reauth.ts` does) with the prod host as the floor, and
 * overridable for a non-prod tenant.
 *
 * Graph requires a publicly reachable HTTPS endpoint, so unlike the internal
 * cron routes this one is genuinely internet-facing. Its protection is the
 * `clientState` secret verified on every inbound notification, not a network
 * boundary.
 */
export function docIngestNotificationUrl(): string {
  const override = process.env['DOC_INGEST_NOTIFICATION_URL']?.trim();
  if (override) return override;
  const base = process.env['NEXTAUTH_URL']?.trim() || 'https://dr3-vision.svdp.us';
  return `${base.replace(/\/+$/, '')}/api/doc-ingest/notifications`;
}

/**
 * ⚠ SUNSET — `GET /me/drive/sharedWithMe` is DEPRECATED.
 *
 * Microsoft deprecated both `/me/drive/sharedWithMe` and `/me/insights/shared`
 * in November 2025. Per learn.microsoft.com they "operate in a degraded state
 * until November 2026, after which [they] stop returning data", and Microsoft
 * has published NO one-to-one replacement — the Q&A thread on the deprecation
 * ends with "I am not aware of any publicly documented one-to-one replacement",
 * pointing vaguely at the Microsoft Search API.
 *
 * This is not a detail. `sharedWithMe` IS discovery: it is the only enumeration
 * of "what has been shared with this account", and the entire D1 premise (the
 * owner shares, Vision reads in place) rests on it.
 *
 * What is done about it here:
 *   - discovery goes through the `SharedItemSource` seam (see `discovery.ts`),
 *     so swapping the enumeration is one implementation, not a rewrite;
 *   - `/admin/doc-ingest/health` renders a countdown from this date;
 *   - it is logged in docs/OPEN-ITEMS.md as a dated, owner-assigned item.
 *
 * A speculative Search-API implementation is deliberately NOT shipped: it cannot
 * be verified against the live tenant today, and an unverified fallback that
 * silently produces a DIFFERENT set of sources is worse than a loud countdown.
 */
export const SHARED_WITH_ME_SUNSET = '2026-11-01';

/** Days until the `sharedWithMe` enumeration stops returning data. May go negative. */
export function sharedWithMeDaysRemaining(now: Date = new Date()): number {
  const sunset = Date.parse(`${SHARED_WITH_ME_SUNSET}T00:00:00Z`);
  return Math.floor((sunset - now.getTime()) / 86_400_000);
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
