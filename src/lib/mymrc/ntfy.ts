// ADR-0038 — self-contained ntfy pager for the MyMRC worker.
//
// The mymrc modules compile standalone via tsconfig.mymrc.json (no `@/` alias),
// so this cannot import `src/lib/ntfy.ts`; it re-implements the ADR-0036
// transport (primary `ntfy.barnardhq.com` + obscured `ntfy.sh` fallback,
// `[DR3-Vision]` title, tier-3 Click) and the ADR-0037 per-fingerprint cooldown.
// Same pattern as upsert.ts duplicating `writeAudit` to stay self-contained.
//
// MyMRC sync failures are explicitly Bill-only SYSTEM events (charter Q16 /
// CLAUDE.md hard rule #5) → topic `dr3-vision-system`. A healthy run is silent.

// ADR-0019.5 — the ONE header sanitizer, at a relative path precisely so this
// alias-less bundle can share it instead of growing a fifth copy of the fix.
import { toHeaderSafe } from './header-safe';
// ADR-0130 — the ONE durable cooldown ledger, at a relative path for the same
// reason `header-safe` is: this bundle has no `@/` alias and cannot import above
// `src/lib/mymrc`. The app-facing name is `src/lib/ntfy-cooldown-store.ts`.
import { claimCooldown, releaseCooldown } from './cooldown-store';
import type { FeedName } from './types';

const PRIMARY_BASE = process.env['NTFY_BASE_URL']?.trim() || 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';
// Pinned obscured fallback topic for `dr3-vision-system` (ntfy-fallback-topics.yml).
const FALLBACK_TOPIC = 'bhq-fb-dr3v-system-410f6daaf633b110fc69c96ae8d78def';
const TOPIC = process.env['NTFY_TOPIC_SYSTEM']?.trim() || 'dr3-vision-system';
// Tier-3 fallback click (ADR-0036): the NOC status page for this service.
const CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
// Tier-2 click: the MyMRC ingestion admin surface (`src/app/admin/mrc-scrape`),
// where an operator sees credential + sync state. Preferred over tier-3 for
// alerts about the INGESTION itself rather than the service being down.
const INGESTION_CLICK_URL =
  process.env['MYMRC_ADMIN_SURFACE_URL']?.trim() ||
  'https://dr3-vision.barnardhq.com/admin/mrc-scrape';
const TIMEOUT_MS = 5_000;

export type AlertKind =
  | 'auth_failed'
  | 'contract_drift'
  | 'zero_anomaly'
  | 'deadman'
  | 'stale_mirror'
  // ADR-0089 D2 — a Delivered haul was detailed and carries NO date on any field;
  // the one residual where "ask MRC" is the right move.
  | 'dateless_hauls'
  | 'error';

export interface PageAlert {
  kind: AlertKind;
  site: string;
  feed?: FeedName;
  message: string;
  /** Explicit dedup fingerprint, e.g. `mymrc-auth-failed:woodland`. */
  fingerprint: string;
  /**
   * Cooldown window. Defaults to this kind's row in the ADR-0130 §6 grading
   * matrix; callers override only when the CONDITION changes the grade.
   */
  cooldownMs?: number;
  /**
   * Priority override. Defaults to this kind's row in the ADR-0130 §6 matrix.
   *
   * The seam exists because two matrix rows are condition-dependent, not
   * kind-dependent: `stale_mirror` escalates to `high` at >= 5 business days
   * (D6), and `error` is promoted to `high` after 3 consecutive failures. The
   * caller is the only thing that knows the streak, so it is the only thing that
   * can escalate.
   */
  priority?: 'default' | 'high' | 'urgent';
}

export interface Pager {
  page(alert: PageAlert): Promise<void>;
}

const TITLE_BY_KIND: Record<AlertKind, string> = {
  auth_failed: 'MyMRC auth failed',
  contract_drift: 'MyMRC portal contract drift',
  zero_anomaly: 'MyMRC zero-row anomaly',
  deadman: 'MyMRC sync deadman (no success >26h)',
  stale_mirror: 'MyMRC mirror stopped advancing',
  dateless_hauls: 'MyMRC Delivered haul(s) with no delivery date',
  error: 'MyMRC sync error',
};

/**
 * Tier-1 record URLs do not exist for these fleet-level alerts, so the choice is
 * tier-2 vs tier-3 (ADR-0036). An alert ABOUT THE INGESTION points at the
 * ingestion admin surface; everything else falls to the NOC status page.
 */
const CLICK_BY_KIND: Record<AlertKind, string> = {
  auth_failed: INGESTION_CLICK_URL,
  contract_drift: INGESTION_CLICK_URL,
  zero_anomaly: INGESTION_CLICK_URL,
  deadman: CLICK_URL,
  stale_mirror: INGESTION_CLICK_URL,
  dateless_hauls: INGESTION_CLICK_URL,
  error: CLICK_URL,
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * ADR-0130 §6 — the re-graded ADR-0037 matrix, per alert kind.
 *
 * Every one of these was `high` / 30 min before, which was a grade nobody had
 * re-examined since ADR-0038 and which the 2026-09-07 storm made unmissable. Note
 * that the OLD numbers were nominal only: published from a one-shot cron process,
 * the cooldown was never actually enforced. Making it enforceable (ADR-0130 D1) is
 * what makes re-grading meaningful rather than decorative.
 *
 * Nothing here is `urgent`. ADR-0037 reserves `urgent` for customer impact now or
 * imminent data loss at a target of <=2/week; every alert below is an internal
 * ingestion signal about a system that bills monthly.
 */
export const GRADE_BY_KIND: Readonly<
  Record<AlertKind, { priority: 'default' | 'high'; cooldownMs: number }>
> = {
  // Q1 yes — Bill re-enters the login at /admin/mrc-scrape. Blocks every feed.
  auth_failed: { priority: 'high', cooldownMs: 6 * HOUR_MS },
  // Q1 no (needs a code change) but it is the leading edge of total blindness.
  contract_drift: { priority: 'high', cooldownMs: 24 * HOUR_MS },
  // Q1 yes — verify the feed by hand. Q3 satisfied: fires against a prior non-zero run.
  zero_anomaly: { priority: 'high', cooldownMs: 12 * HOUR_MS },
  // Q3 satisfied by construction — 26 h of self-heal has already elapsed.
  deadman: { priority: 'high', cooldownMs: 12 * HOUR_MS },
  // Q2 no — internal reconciliation input, never customer-visible, so `default`
  // rather than `high`. Escalated to `high` by the caller at >= 5 business days (D6).
  stale_mirror: { priority: 'default', cooldownMs: 24 * HOUR_MS },
  // Q1 is "ask MRC", i.e. same-day. Residual is 0/7,314 so any fire is genuinely new.
  dateless_hauls: { priority: 'default', cooldownMs: 24 * HOUR_MS },
  // Q3 — one hourly retry is free. Caller promotes to `high` after 3 consecutive.
  error: { priority: 'default', cooldownMs: 6 * HOUR_MS },
};

// ADR-0130 — the cooldown ledger is DURABLE and shared with `src/lib/ntfy.ts`.
//
// This used to be `const cooldown = new Map<string, number>()`, with the note:
// "The worker is spawned per tick, so this dedups WITHIN a run […]; cross-tick
// dedup is enforced by the caller via the run-ledger transition check."
//
// That was true of the alerts the run-ledger covers and FALSE of the ones it does
// not. `stale_mirror` is measured from the mirror's own business dates, not from a
// run-status transition, so nothing upstream deduped it — and because
// `scripts/mymrc-scrape.mjs` is a fresh child process every hour, its 24 h cooldown
// was reset 24 times a day. Bill got two identical `high` pages every hour on the
// hour for four days.

async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // ADR-0019.5 — sanitize at the single choke point both legs share. A raw
    // em dash in `X-Title` throws in undici BEFORE any socket opens, so the
    // primary and the fallback fail identically in the same millisecond and the
    // page is lost while the ntfy server is perfectly healthy. Every MyMRC
    // alert title carried one (`${kind} — ${site}`), so every MyMRC page was
    // being dropped. Authorization is left alone: a bearer is ASCII by
    // construction and mangling it would turn an encoding bug into an auth bug.
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      safeHeaders[k] = k === 'Authorization' ? v : toHeaderSafe(v);
    }
    const resp = await fetch(url, {
      method: 'POST',
      body,
      headers: safeHeaders,
      signal: controller.signal,
    });
    if (!resp.ok) {
      await resp.text().catch(() => '');
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The production pager. Publishes to `dr3-vision-system` with the ADR-0036
 * primary→fallback path and the ADR-0130 DURABLE cooldown claim. Never throws —
 * a paging failure must not fail the sync (`checkMirrorFreshness` explicitly
 * `.catch(() => undefined)`s this call, so a throw here would be swallowed and
 * indistinguishable from a delivery failure).
 */
export const ntfyPager: Pager = {
  async page(alert: PageAlert): Promise<void> {
    const token = process.env['NTFY_PUBLISHER_TOKEN']?.trim();
    if (!token) return; // fail-soft: unconfigured is an operator state, not an error
    // Claim the window atomically BEFORE sending; give it back below if neither
    // transport lands, so a transient ntfy outage cannot silence the alert for the
    // whole window (`checkMirrorFreshness` retries on the next hourly tick).
    const grade = GRADE_BY_KIND[alert.kind];
    const claim = await claimCooldown(alert.fingerprint, alert.cooldownMs ?? grade.cooldownMs);
    if (!claim.claimed) return;

    const feedSuffix = alert.feed ? ` [${alert.feed}]` : '';
    const title = `[DR3-Vision] ${TITLE_BY_KIND[alert.kind]} - ${alert.site}${feedSuffix}`.slice(
      0,
      250,
    );
    const body = `${alert.message}\n\nfingerprint=${alert.fingerprint}`;
    // ADR-0130 §6 — per KIND, not a blanket `high`. Until this change every MyMRC
    // alert was `high`, which is the grade that made four days of hourly pages
    // land as four days of hourly URGENT-adjacent buzzes rather than a daily note.
    const priority = alert.priority ?? grade.priority;
    const tags = `mymrc,${alert.kind},dr3-vision`;
    const click = CLICK_BY_KIND[alert.kind];

    const ok = await postWithTimeout(`${PRIMARY_BASE}/${TOPIC}`, body, {
      'X-Title': title,
      Priority: priority,
      Click: click,
      Tags: tags,
      Authorization: `Bearer ${token}`,
    });
    if (ok) return;
    const fallbackOk = await postWithTimeout(`${FALLBACK_BASE}/${FALLBACK_TOPIC}`, body, {
      'X-Title': `[FALLBACK] ${title}`.slice(0, 250),
      Priority: priority,
      Click: click,
      Tags: tags,
    });
    if (!fallbackOk) await releaseCooldown(alert.fingerprint, claim.expiresAt);
  },
};

/** Canonical fingerprints (ADR-0038 D4). */
export const fingerprint = {
  authFailed: (site: string): string => `mymrc-auth-failed:${site}`,
  contractDrift: (site: string, feed: FeedName): string => `mymrc-contract-drift:${site}:${feed}`,
  zeroAnomaly: (site: string, feed: FeedName): string => `mymrc-zero-anomaly:${site}:${feed}`,
  deadman: (site: string, feed: FeedName): string => `mymrc-deadman:${site}:${feed}`,
  error: (site: string, feed: FeedName): string => `mymrc-error:${site}:${feed}`,
};
