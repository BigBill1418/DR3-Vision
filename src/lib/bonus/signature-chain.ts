// T-208 — Signature-chain lookup (ADR-0019.2 §2).
//
// The `bonus_signature_chains` table is the SINGLE SOURCE OF TRUTH for "who
// signs which slot at which site" and "who may override which slot" — there is
// NO hardcoded `if (site === 'woodland') signAsJanette()` anywhere (addendum
// hard rule #2). This module reads one row per site and hands the signature
// service (`@/lib/bonus/signatures.ts`) and the escalation cron (T-205) a
// resolved, typed chain.
//
// Override-actor lists are stored on the row as comma-separated UUID strings
// (`facility_override_actor_ids`, `ops_override_actor_ids`) — see the
// `BonusSignatureChain` model + the T-201 seed, which resolves the CSV's email
// lists to user UUIDs and re-joins them with commas. We split on `,`, trim,
// and drop blanks back into `string[]`.
//
// The auto-override actor (`auto_override_actor_user_id`) is likewise read from
// the row, never hardcoded as Bill (addendum hard rule #3). Today it is Bill
// for both sites; the column lets that change without code edits.
//
// Caching: the chain does not change mid-request, so a lookup is memoised per
// (db-instance, site_id) for the request lifecycle. In production the Prisma
// singleton is the same object across a request, so a `WeakMap` keyed on the db
// instance gives request-scoped caching without leaking across DB clients (and
// without holding a reference that would prevent GC of a per-test double).

import { prisma } from '@/lib/prisma';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/** The resolved chain for one site. All ids are user UUIDs. */
export interface SignatureChain {
  facility_signer_user_id: string;
  /** Users who may override the facility slot (parsed from the CSV column). */
  facility_override_actor_user_ids: string[];
  ops_signer_user_id: string;
  /** Users who may override the ops slot (parsed from the CSV column). */
  ops_override_actor_user_ids: string[];
  /** The user the escalation cron signs AS at the Tue 08:30 PT deadline. */
  auto_override_actor_user_id: string;
}

/** The raw `bonus_signature_chains` row this module reads. */
export interface SignatureChainRow {
  facility_signer_user_id: string;
  facility_override_actor_ids: string;
  ops_signer_user_id: string;
  ops_override_actor_ids: string;
  auto_override_actor_user_id: string;
}

/** Minimal structural shape of the Prisma client this module needs. */
export interface SignatureChainDb {
  bonusSignatureChain: {
    findUnique(args: {
      where: { site_id: string };
      select?: Record<string, boolean>;
    }): Promise<SignatureChainRow | null>;
  };
}

// ────────────────────────────────────────────────────────────────────
// Parsing
// ────────────────────────────────────────────────────────────────────

/**
 * Parse one of the comma-separated UUID columns into a `string[]`. Mirrors how
 * the T-201 seed STORED these (resolve each email → UUID, `join(',')`); we run
 * the inverse split. Tolerant of stray whitespace and a trailing comma.
 */
export function parseOverrideActorIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────
// Lookup (request-lifecycle cached)
// ────────────────────────────────────────────────────────────────────

/**
 * Per-(db, site) memo of the in-flight/resolved chain. Keyed on the db instance
 * so a per-test double does not share cache with the production singleton, and
 * so the entry is collected when the db instance is. We cache the PROMISE so
 * concurrent callers in the same request coalesce onto one query.
 */
const chainCache = new WeakMap<object, Map<string, Promise<SignatureChain>>>();

export class SignatureChainNotFoundError extends Error {
  constructor(public readonly siteId: string) {
    super(`No bonus_signature_chains row for site_id='${siteId}' (chain not seeded?)`);
    this.name = 'SignatureChainNotFoundError';
  }
}

/**
 * Resolve the signature chain for a site. Reads the single
 * `bonus_signature_chains` row for `siteId` and parses the override-actor
 * columns into arrays. Cached per-site for the request lifecycle.
 *
 * @param siteId The site's UUID (`sites.id`), NOT a site code.
 * @param db     Override the Prisma client (tests inject a double); defaults to
 *               the global singleton.
 * @throws {SignatureChainNotFoundError} when the site has no chain row.
 */
export function getSignatureChain(
  siteId: string,
  db: SignatureChainDb = prisma,
): Promise<SignatureChain> {
  let perSite = chainCache.get(db as object);
  if (!perSite) {
    perSite = new Map();
    chainCache.set(db as object, perSite);
  }
  const cached = perSite.get(siteId);
  if (cached) return cached;

  const loading = loadSignatureChain(siteId, db);
  perSite.set(siteId, loading);
  // On failure, evict so a later call can retry rather than re-throwing a stale
  // rejected promise for the rest of the request.
  void loading.catch(() => perSite!.delete(siteId));
  return loading;
}

async function loadSignatureChain(
  siteId: string,
  db: SignatureChainDb,
): Promise<SignatureChain> {
  const row = await db.bonusSignatureChain.findUnique({
    where: { site_id: siteId },
    select: {
      facility_signer_user_id: true,
      facility_override_actor_ids: true,
      ops_signer_user_id: true,
      ops_override_actor_ids: true,
      auto_override_actor_user_id: true,
    },
  });
  if (!row) throw new SignatureChainNotFoundError(siteId);

  return {
    facility_signer_user_id: row.facility_signer_user_id,
    facility_override_actor_user_ids: parseOverrideActorIds(row.facility_override_actor_ids),
    ops_signer_user_id: row.ops_signer_user_id,
    ops_override_actor_user_ids: parseOverrideActorIds(row.ops_override_actor_ids),
    auto_override_actor_user_id: row.auto_override_actor_user_id,
  };
}

/**
 * The configured auto-override actor for a site (ADR-0019.1 §4 escalation). The
 * escalation cron (T-205) signs unsigned slots AS this user at Tue 08:30 PT.
 * Never hardcoded — read from the chain (addendum hard rule #3).
 */
export async function getAutoOverrideActor(
  siteId: string,
  db: SignatureChainDb = prisma,
): Promise<string> {
  const chain = await getSignatureChain(siteId, db);
  return chain.auto_override_actor_user_id;
}

/**
 * Test/escalation seam: drop the cached chain for a site (or all sites for a
 * db). Production never needs this — a fresh request gets a fresh cache via the
 * WeakMap-keyed db instance — but a long-lived cron tick or a test that mutates
 * a chain can clear it.
 */
export function clearSignatureChainCache(db: SignatureChainDb = prisma, siteId?: string): void {
  const perSite = chainCache.get(db as object);
  if (!perSite) return;
  if (siteId) perSite.delete(siteId);
  else perSite.clear();
}
