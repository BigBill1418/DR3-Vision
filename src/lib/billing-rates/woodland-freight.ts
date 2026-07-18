// ADR-0040 amendment (2026-07-18, rollup §3.5) — the TRANSITIONAL Woodland freight rule.
//
// Rollup §3.5: for ANY Woodland (CA)-jurisdiction load, freight is ALWAYS priced off the
// source's PRIMARY haul rate + PRIMARY mileage — regardless of the load's actual site
// Assignment (Primary / Secondary / Tertiary). This is a deliberate transitional
// simplification until the multi-destination Assignment model lands; encoding it now
// makes the policy explicit and TESTED, so when Assignment arrives this resolver already
// pins freight to Primary and a Secondary/Tertiary assignment can never silently change
// the billed rate.
//
// HOW "PRIMARY" MAPS ONTO THE CURRENT SCHEMA (no Assignment table exists yet):
//   - Primary haul RATE  = the in-force `account_haul_rates` override for the source, if
//                          any (the negotiated per-account rate).
//   - Primary MILEAGE    = the source's single `canonical_mileage`.
// So the three-way §3.5 decision tree is exactly the override → tier → typed-error order
// the audited `resolveFreightCents` already implements for a CA source, where its `tier`
// leg IS the CA Event Mile Rate table (see event-mile-rate.ts / §3.7):
//   1. Primary defined (override in force)            → Primary rate      (ref: override)
//   2. no override, Primary mileage set               → Event Mile tier   (ref: tier)
//   3. no override, no mileage (source unknown/unset) → FreightUnresolvableError
//
// This module therefore DELEGATES to `resolveFreightCents` rather than re-implementing
// the override/tier/tie fetch — one audited money path, no drift. It adds ONLY the
// Woodland contract: it verifies the source is CA (Woodland) and rejects a non-CA source
// with a typed error (a caller routing an Oregon load here is a bug, and OR freight is
// unseeded by design). CA non-Woodland ("normal Assignment-based") loads do NOT come
// through here — they use `resolveFreightCents` directly; that path is unchanged.

import { log } from '@/lib/observability/logger';
import {
  resolveFreightCents,
  FreightUnresolvableError,
  type FreightResolverDb,
  type ResolvedFreight,
} from './freight-resolver';

/** The Woodland freight resolver was handed a non-CA (Oregon) source — a routing bug. */
export class WoodlandJurisdictionError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly sourceId: string,
    readonly jurisdiction: 'OR',
  ) {
    super(
      `resolveWoodlandFreightCents received a non-CA source ${sourceId} ` +
        `(jurisdiction=${jurisdiction}); Woodland freight is CA-only`,
    );
    this.name = 'WoodlandJurisdictionError';
  }
}

export interface ResolveWoodlandFreightArgs {
  sourceId: string;
  /** The load date the freight is priced as-of. */
  date: Date;
  db: FreightResolverDb;
}

function isoDay(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Resolve freight for a Woodland (CA) load under the transitional §3.5 rule — always
 * Primary. Verifies the source is CA, then delegates to the audited
 * {@link resolveFreightCents} (override → Event Mile tier → typed error). Its result's
 * `ref.kind` distinguishes the §3.5 branch taken: `override` = Primary rate;
 * `tier` = Event Mile Rate fallback (§3.7).
 *
 * Throws:
 *   - {@link WoodlandJurisdictionError} if the source is Oregon (routing bug),
 *   - {@link FreightUnresolvableError} (`source_not_found` | `no_mileage` |
 *     `no_tier_for_mileage` | `ambiguous_*`) — never a silent $0 (ADR-0040 D7).
 */
export async function resolveWoodlandFreightCents(
  args: ResolveWoodlandFreightArgs,
): Promise<ResolvedFreight> {
  const { sourceId, date, db } = args;
  const day = isoDay(date);

  // CA (Woodland) guard. Read the source once for the jurisdiction check; a missing
  // source surfaces as the same typed source_not_found the delegate would raise, so
  // the failure taxonomy stays consistent.
  const source = await db.source.findUnique({
    where: { id: sourceId },
    select: { id: true, canonical_mileage: true, site: { select: { jurisdiction: true } } },
  });
  if (!source || !source.site) {
    log.warn({ source_id: sourceId, date: day }, '[woodland-freight] source not found');
    throw new FreightUnresolvableError('source_not_found', {
      source_id: sourceId,
      date: day,
      mileage: null,
      jurisdiction: null,
    });
  }
  if (source.site.jurisdiction === 'oregon') {
    log.warn(
      { source_id: sourceId, date: day },
      '[woodland-freight] non-CA source routed to the Woodland resolver',
    );
    throw new WoodlandJurisdictionError(sourceId, 'OR');
  }

  const resolved = await resolveFreightCents({ sourceId, date, db });
  log.debug(
    { source_id: sourceId, date: day, branch: resolved.ref.kind, cents: resolved.cents },
    '[woodland-freight] resolved (transitional always-Primary rule)',
  );
  return resolved;
}
