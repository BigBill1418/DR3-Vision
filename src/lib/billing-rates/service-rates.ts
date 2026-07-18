// ADR-0040 amendment (2026-07-18, rollup §3.3) — per-source, effective-dated resolver
// for the OR program billing-component rates (trans / trailer / per-mattress / MRC unit).
//
// The OR sources bill trans/trailer/per-mattress (and the MRC unit rate) at per-source
// rates that CHANGE over time (§3.3: The Dalles's rates take effect 2026-06-01; the rest
// 2026-01-01). Flat columns can't carry effective dates, so these live in the
// `source_service_rates` table — the same per-source effective-dated shape as
// `account_haul_rates`. This resolver is the read half, mirroring `resolveFreightCents`:
// it picks the in-force row (latest `effective_from <= date`, not end-dated), detects a
// same-`effective_from` tie, and throws a TYPED error when none is in force — an OR
// billing component MUST NOT silently bill $0 (ADR-0040 D7).
//
// `db` is injected (not the global `prisma`) so this unit-tests against an in-memory
// fake, mirroring the freight resolver's `FreightResolverDb` pattern.

import { log } from '@/lib/observability/logger';

/** Which OR billing-component rate is being resolved. Mirrors `SourceServiceRateKind`. */
export type ServiceRateKind = 'trans' | 'trailer' | 'per_mattress' | 'mrc_unit';

/** Which `source_service_rates` row priced a component — persisted as provenance. */
export type ServiceRateRef = { kind: 'source_service_rate'; id: string };

export interface ResolvedServiceRate {
  cents: number;
  ref: ServiceRateRef;
}

export type ServiceRateUnresolvableReason =
  | 'no_rate_in_force' // no row for (source, kind) covers the date
  | 'ambiguous_rate'; // two in-force rows share an effective_from — fix the data

export class ServiceRateUnresolvableError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly reason: ServiceRateUnresolvableReason,
    readonly context: {
      source_id: string;
      rate_kind: ServiceRateKind;
      date: string; // ISO yyyy-mm-dd
    },
  ) {
    super(
      `service rate unresolvable (${reason}) for ${context.rate_kind} ` +
        `on source ${context.source_id} as of ${context.date}`,
    );
    this.name = 'ServiceRateUnresolvableError';
  }
}

interface ServiceRateRow {
  id: string;
  effective_from: Date;
  effective_to: Date | null;
  rate_cents: number;
}

export interface ServiceRateResolverDb {
  sourceServiceRate: {
    findMany(args: {
      where: {
        source_id: string;
        rate_kind: ServiceRateKind;
        effective_from: { lte: Date };
        OR: Array<{ effective_to: null } | { effective_to: { gte: Date } }>;
      };
      orderBy: { effective_from: 'desc' };
      take: number;
    }): Promise<ServiceRateRow[]>;
  };
}

export interface ResolveServiceRateArgs {
  sourceId: string;
  kind: ServiceRateKind;
  /** The date the rate is resolved as-of. */
  date: Date;
  db: ServiceRateResolverDb;
}

/** Normalize a Date to UTC midnight of its calendar day — matches `@db.Date` storage. */
function dateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date): string {
  return dateUTC(date).toISOString().slice(0, 10);
}

/**
 * Resolve a per-source service-component rate in integer cents with provenance. Picks
 * the in-force row for `(sourceId, kind)` on `date`; throws
 * {@link ServiceRateUnresolvableError} when none is in force or two tie on
 * `effective_from` — never returns a default.
 */
export async function resolveSourceServiceRateCents(
  args: ResolveServiceRateArgs,
): Promise<ResolvedServiceRate> {
  const { sourceId, kind, db } = args;
  const on = dateUTC(args.date);
  const day = isoDay(args.date);

  const rows = await db.sourceServiceRate.findMany({
    where: {
      source_id: sourceId,
      rate_kind: kind,
      effective_from: { lte: on },
      OR: [{ effective_to: null }, { effective_to: { gte: on } }],
    },
    orderBy: { effective_from: 'desc' },
    take: 2,
  });

  // Tie detection (mirrors resolveFreightCents' ambiguous_override guard): two in-force
  // rows sharing an effective_from would otherwise coin-flip the billed rate.
  if (
    rows.length === 2 &&
    rows[0]!.effective_from.getTime() === rows[1]!.effective_from.getTime()
  ) {
    throw new ServiceRateUnresolvableError('ambiguous_rate', {
      source_id: sourceId,
      rate_kind: kind,
      date: day,
    });
  }

  const row = rows[0];
  if (!row) {
    log.warn(
      { source_id: sourceId, rate_kind: kind, date: day },
      '[service-rate] no rate in force',
    );
    throw new ServiceRateUnresolvableError('no_rate_in_force', {
      source_id: sourceId,
      rate_kind: kind,
      date: day,
    });
  }

  log.debug(
    { source_id: sourceId, rate_kind: kind, date: day, ref_id: row.id, cents: row.rate_cents },
    '[service-rate] resolved',
  );
  return { cents: row.rate_cents, ref: { kind: 'source_service_rate', id: row.id } };
}
