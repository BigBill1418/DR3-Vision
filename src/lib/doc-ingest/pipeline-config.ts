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
 * A speculative Search-API implementation is deliberately NOT shipped as the
 * ENUMERATION: measured against the live tenant on 2026-08-07 it returns 11,442
 * items — the whole tenant, not the shared set — so swapping discovery onto it
 * would start watching half of SVdP's SharePoint. See `reachability.ts` for what
 * Search IS used for, and ADR-0080 for the measurements.
 *
 * ── The date is an INFERENCE, not a citation (corrected 2026-08-07) ─────────
 * Microsoft's reference page says only "November, 2026" — it names no day. This
 * constant picks the FIRST of that month, which is the conservative reading (it
 * can only be early, never late). Nothing may present it as Microsoft's stated
 * date; `SHARED_WITH_ME_SUNSET_IS_INFERRED` exists so surfaces can say so.
 * https://learn.microsoft.com/en-us/graph/api/drive-sharedwithme?view=graph-rest-1.0
 */
export const SHARED_WITH_ME_SUNSET = '2026-11-01';

/**
 * True because Microsoft published a MONTH, not a date. Surfaces that render the
 * countdown must qualify it — an invented precision would have the fleet trust a
 * day that no vendor ever promised.
 */
export const SHARED_WITH_ME_SUNSET_IS_INFERRED = true;

/** Days until the `sharedWithMe` enumeration stops returning data. May go negative. */
export function sharedWithMeDaysRemaining(now: Date = new Date()): number {
  const sunset = Date.parse(`${SHARED_WITH_ME_SUNSET}T00:00:00Z`);
  return Math.floor((sunset - now.getTime()) / 86_400_000);
}

// ── Reachability scanning (ADR-0080 §Phase 1) ───────────────────────────────
//
// The question this configuration bounds: "what CAN Vision read that it is not
// watching?" — deliberately a narrower question than "what can this identity
// reach", because the identity holds `Sites.Read.All` and can reach the entire
// tenant, including Night Shelter case-management files that Vision must never
// touch.
//
// The bound is a KQL scope, and it is STATED on the health surface rather than
// left implicit. That is the same discipline as `depth_limit_reached`: a bounded
// enumeration is correct, being quiet about what the bound excluded is not.
//
// Measured live 2026-08-07 (docs-dr3@svdp.us):
//   • unscoped `*`                                  → 11,442 items (whole tenant)
//   • `filetype:xlsx`                               →    593 items
//   • THIS scope                                    →     11 items, and exactly
//     the DR3 document universe — no case-management or HR material at all,
//     because those live on the team-sites host, not the personal-OneDrive host.
//
// `SharedWithUsersOWSUser:"<upn>"` — the documented SharePoint managed property
// for "shared with this person" — was tested against this tenant on the same day
// and returned **total = 0**. It is NOT a usable narrowing here (Microsoft
// documents it as indexing only "Specific people" shares; these are link
// shares). Recorded so nobody re-derives it.

/**
 * The host that holds personal OneDrive content in this tenant. Every document
 * shared with Vision so far lives here; team sites (the `-my`-less host) hold
 * the material Vision has no business reading.
 */
export function docIngestReachabilityHost(): string {
  return process.env['DOC_INGEST_REACHABILITY_HOST'] ?? 'https://svdplanecounty-my.sharepoint.com';
}

/** File types worth comparing. Vision only ever absorbs spreadsheets. */
export function docIngestReachabilityFiletypes(): string[] {
  const raw = process.env['DOC_INGEST_REACHABILITY_FILETYPES'];
  const parsed = (raw ?? 'xlsx,xlsm,xlsb,csv')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : ['xlsx'];
}

/**
 * The KQL the scan actually issues — built here, in one place, so the surface can
 * render the EXACT string that produced the numbers rather than a description of
 * it. A scope a human cannot read back is a scope nobody can audit.
 */
export function docIngestReachabilityScope(): string {
  const types = docIngestReachabilityFiletypes()
    .map((t) => `filetype:${t}`)
    .join(' OR ');
  return `(${types}) AND path:"${docIngestReachabilityHost()}"`;
}

/**
 * Hard cap on hits pulled per scan. Microsoft caps `size` at 1000 per page; this
 * is deliberately far below it — the scan is a comparison, not an inventory, and
 * a scope that returns hundreds is a scope that needs narrowing, not paging.
 */
export function docIngestReachabilityLimit(): number {
  return positiveIntEnv('DOC_INGEST_REACHABILITY_LIMIT', 200);
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
