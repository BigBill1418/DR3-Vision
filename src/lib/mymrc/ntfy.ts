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

import type { FeedName } from './types';

const PRIMARY_BASE = process.env['NTFY_BASE_URL']?.trim() || 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';
// Pinned obscured fallback topic for `dr3-vision-system` (ntfy-fallback-topics.yml).
const FALLBACK_TOPIC = 'bhq-fb-dr3v-system-k8m2n';
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
  /** Cooldown window; defaults per ADR-0037 (30 min for these system alerts). */
  cooldownMs?: number;
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

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

// In-process cooldown ledger. The worker is spawned per tick, so this dedups
// WITHIN a run (e.g. the same auth failure across all three feeds); cross-tick
// dedup is enforced by the caller via the run-ledger transition check.
const cooldown = new Map<string, number>();

async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
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
 * primary→fallback path and an in-process cooldown. Never throws — a paging
 * failure must not fail the sync.
 */
export const ntfyPager: Pager = {
  async page(alert: PageAlert): Promise<void> {
    const token = process.env['NTFY_PUBLISHER_TOKEN']?.trim();
    if (!token) return; // fail-soft: unconfigured is an operator state, not an error
    const now = Date.now();
    const until = cooldown.get(alert.fingerprint);
    if (until !== undefined && until > now) return;
    cooldown.set(alert.fingerprint, now + (alert.cooldownMs ?? DEFAULT_COOLDOWN_MS));

    const feedSuffix = alert.feed ? ` [${alert.feed}]` : '';
    const title = `[DR3-Vision] ${TITLE_BY_KIND[alert.kind]} — ${alert.site}${feedSuffix}`.slice(
      0,
      250,
    );
    const body = `${alert.message}\n\nfingerprint=${alert.fingerprint}`;
    // Every MyMRC alert is graded `high` under ADR-0037: each one is actionable
    // within the hour, none is customer-visible at the moment it fires, and none
    // warrants a 3 a.m. wake. (This was previously written as a ternary whose
    // branches were both 'high', implying a distinction that did not exist.)
    const priority = 'high';
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
    await postWithTimeout(`${FALLBACK_BASE}/${FALLBACK_TOPIC}`, body, {
      'X-Title': `[FALLBACK] ${title}`.slice(0, 250),
      Priority: priority,
      Click: click,
      Tags: tags,
    });
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
