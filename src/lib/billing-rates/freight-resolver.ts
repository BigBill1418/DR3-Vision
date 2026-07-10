// ADR-0040 D2 — the ONE named freight resolver.
//
// Resolution order for a transport-charged load's freight (Addendum B2 — freight
// is COMPUTED, never typed):
//   1. an `account_haul_rates` override in force for the source on the load date
//      (latest `effective_from` wins) → provenance ref {kind:'override'}, else
//   2. the `transport_rate_tiers` band for the source's `canonical_mileage`, in
//      the source's site jurisdiction (california→CA, oregon→OR), in force on the
//      date → provenance ref {kind:'tier'}, else
//   3. a typed {@link FreightUnresolvableError} carrying source_id + date + mileage
//      + jurisdiction + reason. A transport-charged load from a source with no
//      mileage, or in a jurisdiction with no seeded tier band, can NEVER silently
//      bill $0 (ADR-0040 D2/D7 — money paths fail loud).
//
// The returned `ref` is the provenance the ADR-0037 `inbound_loads.freight_rate_ref`
// column stores so the retro-audit can prove which row priced each haul.
//
// `db` is injected (not the global `prisma`) so this resolver unit-tests against an
// in-memory fake — mirrors the ADR-0040 D2 signature `resolveFreightCents({sourceId,
// date, db})`. Observability per D7: a debug line records the resolution path; a
// warn line + typed error records every failure with full context.

import { log } from '@/lib/observability/logger';

/** CA|OR — the freight table's own jurisdiction key (distinct from site `Jurisdiction`). */
export type FreightJurisdiction = 'CA' | 'OR';

/** Which row priced a haul — persisted as freight provenance for the retro-audit. */
export type FreightRateRef = { kind: 'override'; id: string } | { kind: 'tier'; id: string };

export interface ResolvedFreight {
  cents: number;
  ref: FreightRateRef;
}

/** Why freight could not be resolved — each value surfaces in the error + log line. */
export type FreightUnresolvableReason =
  | 'source_not_found'
  | 'no_mileage' // source has no canonical_mileage and no override
  | 'no_tier_for_mileage' // mileage set but no band covers it (incl. OR-not-seeded)
  | 'ambiguous_override' // two in-force overrides share an effective_from — fix the data
  | 'ambiguous_tier'; // two in-force tier windows tie — fix the data

export class FreightUnresolvableError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly reason: FreightUnresolvableReason,
    readonly context: {
      source_id: string;
      date: string; // ISO yyyy-mm-dd
      mileage: number | null;
      jurisdiction: FreightJurisdiction | null;
    },
  ) {
    super(
      `freight unresolvable (${reason}) for source ${context.source_id} on ${context.date} ` +
        `[mileage=${context.mileage ?? 'null'}, jurisdiction=${context.jurisdiction ?? 'null'}]`,
    );
    this.name = 'FreightUnresolvableError';
  }
}

// ── Minimal DB surface the resolver needs (structural — a Prisma client satisfies it) ──

interface AccountHaulRateRow {
  id: string;
  effective_from: Date;
  effective_to: Date | null;
  rate_cents: number;
}
interface TransportRateTierRow {
  id: string;
  min_miles: number;
  max_miles: number;
  rate_cents: number;
  effective_from: Date;
  effective_to: Date | null;
}
interface SourceRow {
  id: string;
  canonical_mileage: number | null;
  site: { jurisdiction: 'california' | 'oregon' } | null;
}

export interface FreightResolverDb {
  accountHaulRate: {
    findMany(args: {
      where: {
        source_id: string;
        effective_from: { lte: Date };
        OR: Array<{ effective_to: null } | { effective_to: { gte: Date } }>;
      };
      orderBy: { effective_from: 'desc' };
      take: number;
    }): Promise<AccountHaulRateRow[]>;
  };
  source: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; canonical_mileage: true; site: { select: { jurisdiction: true } } };
    }): Promise<SourceRow | null>;
  };
  transportRateTier: {
    findMany(args: {
      where: {
        jurisdiction: FreightJurisdiction;
        min_miles: { lte: number };
        max_miles: { gte: number };
        effective_from: { lte: Date };
        OR: Array<{ effective_to: null } | { effective_to: { gte: Date } }>;
      };
      orderBy: { effective_from: 'desc' };
    }): Promise<TransportRateTierRow[]>;
  };
}

export interface ResolveFreightArgs {
  sourceId: string;
  /** The load date the freight is priced as-of. */
  date: Date;
  db: FreightResolverDb;
}

/** Normalize a Date to UTC midnight of its calendar day — matches `@db.Date` storage. */
function dateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date): string {
  return dateUTC(date).toISOString().slice(0, 10);
}

function freightJurisdiction(site: { jurisdiction: 'california' | 'oregon' }): FreightJurisdiction {
  return site.jurisdiction === 'california' ? 'CA' : 'OR';
}

/**
 * Resolve freight in integer cents with provenance. See module header for the
 * override→tier→typed-error order. Throws {@link FreightUnresolvableError} rather
 * than returning any default — a transport-charged load MUST NOT silently bill $0.
 */
export async function resolveFreightCents(args: ResolveFreightArgs): Promise<ResolvedFreight> {
  const { sourceId, db } = args;
  const on = dateUTC(args.date);
  const day = isoDay(args.date);

  // 1 — account override in force (latest effective_from ≤ date, not end-dated).
  const overrides = await db.accountHaulRate.findMany({
    where: {
      source_id: sourceId,
      effective_from: { lte: on },
      OR: [{ effective_to: null }, { effective_to: { gte: on } }],
    },
    orderBy: { effective_from: 'desc' },
    take: 2,
  });
  // Tie detection (mirrors resolveProgramRule's AmbiguousProgramRuleError): two
  // in-force overrides sharing an effective_from would otherwise coin-flip the
  // billed rate. admin-rates now refuses to create the tie; this guards legacy
  // rows and any path that bypassed the service.
  if (
    overrides.length === 2 &&
    overrides[0]!.effective_from.getTime() === overrides[1]!.effective_from.getTime()
  ) {
    throw new FreightUnresolvableError('ambiguous_override', {
      source_id: sourceId,
      date: day,
      mileage: null,
      jurisdiction: null,
    });
  }
  const override = overrides[0];
  if (override) {
    log.debug(
      {
        source_id: sourceId,
        date: day,
        path: 'override',
        ref_id: override.id,
        cents: override.rate_cents,
      },
      '[freight] resolved via account override',
    );
    return { cents: override.rate_cents, ref: { kind: 'override', id: override.id } };
  }

  // 2 — tier lookup on the source's canonical mileage + jurisdiction.
  const source = await db.source.findUnique({
    where: { id: sourceId },
    select: { id: true, canonical_mileage: true, site: { select: { jurisdiction: true } } },
  });
  if (!source || !source.site) {
    log.warn({ source_id: sourceId, date: day }, '[freight] source not found');
    throw new FreightUnresolvableError('source_not_found', {
      source_id: sourceId,
      date: day,
      mileage: null,
      jurisdiction: null,
    });
  }
  const jurisdiction = freightJurisdiction(source.site);

  if (source.canonical_mileage == null) {
    log.warn(
      { source_id: sourceId, date: day, jurisdiction },
      '[freight] source has no canonical_mileage and no override',
    );
    throw new FreightUnresolvableError('no_mileage', {
      source_id: sourceId,
      date: day,
      mileage: null,
      jurisdiction,
    });
  }
  const mileage = source.canonical_mileage;

  const tiers = await db.transportRateTier.findMany({
    where: {
      jurisdiction,
      min_miles: { lte: mileage },
      max_miles: { gte: mileage },
      effective_from: { lte: on },
      OR: [{ effective_to: null }, { effective_to: { gte: on } }],
    },
    orderBy: { effective_from: 'desc' },
  });
  if (
    tiers.length >= 2 &&
    tiers[0]!.effective_from.getTime() === tiers[1]!.effective_from.getTime()
  ) {
    throw new FreightUnresolvableError('ambiguous_tier', {
      source_id: sourceId,
      date: day,
      mileage,
      jurisdiction,
    });
  }
  const tier = tiers[0];
  if (!tier) {
    // Covers the OR-not-seeded case: no tier band exists for this mileage in this
    // jurisdiction/effective window (ADR-0040 — OR tiers are unseeded until Rick
    // provides them, so OR freight is a typed error, not a silent $0).
    log.warn(
      { source_id: sourceId, date: day, jurisdiction, mileage },
      '[freight] no tier band covers the mileage',
    );
    throw new FreightUnresolvableError('no_tier_for_mileage', {
      source_id: sourceId,
      date: day,
      mileage,
      jurisdiction,
    });
  }

  log.debug(
    {
      source_id: sourceId,
      date: day,
      path: 'tier',
      jurisdiction,
      mileage,
      ref_id: tier.id,
      cents: tier.rate_cents,
    },
    '[freight] resolved via tier band',
  );
  return { cents: tier.rate_cents, ref: { kind: 'tier', id: tier.id } };
}
