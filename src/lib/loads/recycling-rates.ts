// ADR-0055 — recycling-rate configuration + outbound stewardship derivation.
//
// Steel recyclers count different fractions of an outbound load as RECYCLED vs
// LANDFILLED (Green Zone metal = 100%; Xtraction metal = 81% steel / 19% landfill;
// Biomass wood = 100%). Those splits feed CalRecycle stewardship reporting (O-7) —
// they are NOT part of the MRC invoice (ADR-0041 removed commodity mapping from
// invoicing; the invoice is single-line units × rate).
//
// Two concerns live here:
//   1. `deriveRecyclingSplit` — the PURE pound-split math. Rounding rule:
//        recycled_lbs  = round-half-up(weight_lbs × recycling_percent)
//        landfilled_lbs = weight_lbs − recycled_lbs   (complement by subtraction)
//      Deriving landfilled as the COMPLEMENT (never a second independent round)
//      makes `recycled + landfilled === weight_lbs` hold for EVERY rate/weight,
//      with no pound drift — the failure mode two independent rounds would create
//      (e.g. weight 5 @ 0.5 → round(2.5)=3 and round(2.5)=3 would sum to 6).
//   2. `resolveRecyclingRate` — the strict, effective-dated resolver, mirroring
//      `state_program_rules` (src/lib/program-rules/resolver.ts): the row whose
//      `effective_from <= onDate` and `effective_to` is null or `>= onDate` wins.
//      Overlapping windows are forbidden by construction (DB partial-unique on open
//      windows + the transactional write guard `createRecyclingRate`), so MORE THAN
//      ONE covering row is a data-integrity error and THROWS — a rate is never
//      coin-flipped.
//
// No-rate policy: when no row covers (vendor, commodity, ship_date), derivation
// returns `{ status: 'no_rate' }` and the caller LEAVES the derived fields null and
// flags the row. A missing rate is NEVER silently treated as 100% recycled — that
// would over-report recycling to CalRecycle.

import { Prisma, type OutboundCommodity, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { RecordValidationError } from '@/lib/loads/record-guards';

/** decimal.js round-half-up mode (Prisma re-exports decimal.js as Prisma.Decimal). */
const ROUND_HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

// ── No-rate / ambiguity signalling ────────────────────────────────────────────

/**
 * More than one `recycling_rates` row covers the requested (vendor, commodity,
 * date). Overlapping windows are structurally forbidden (partial-unique on open
 * windows + the `createRecyclingRate` write guard), so this can only fire if a row
 * was inserted OUTSIDE the guarded path — a corruption worth surfacing loudly, not
 * a rate to coin-flip. Names the tied row ids so an operator can end-date the stray.
 */
export class AmbiguousRecyclingRateError extends Error {
  readonly status = 409 as const;
  constructor(
    vendorId: string,
    commodity: OutboundCommodity,
    onDate: Date,
    readonly rateIds: string[],
  ) {
    super(
      `ambiguous recycling_rates for vendor ${vendorId} commodity ${commodity} on ${onDate
        .toISOString()
        .slice(0, 10)}: ${rateIds.length} rows cover the date (ids: ${rateIds.join(', ')}) — end-date the stale row`,
    );
    this.name = 'AmbiguousRecyclingRateError';
  }
}

/** A proposed rate window overlaps an existing one for the same (vendor, commodity). */
export class RecyclingRateOverlapError extends Error {
  readonly status = 409 as const;
  constructor(
    vendorId: string,
    commodity: OutboundCommodity,
    readonly conflictingRateIds: string[],
  ) {
    super(
      `recycling_rates window overlaps an existing rate for vendor ${vendorId} commodity ${commodity} (ids: ${conflictingRateIds.join(', ')}) — end-date the current rate before adding a new one`,
    );
    this.name = 'RecyclingRateOverlapError';
  }
}

// ── Pure split math ───────────────────────────────────────────────────────────

/** A recycled / landfilled split in whole pounds. Invariant: recycled + landfilled === weightLbs. */
export interface RecyclingSplit {
  recycledLbs: number;
  landfilledLbs: number;
  /** The fraction applied, normalized to a Decimal(5,4) string (e.g. "0.8100"). */
  recyclingPercent: string;
}

/**
 * Split a whole-pound load weight into recycled + landfilled pounds at a recycling
 * fraction. Round-half-up on recycled; landfilled is the exact complement.
 *
 * @param weightLbs        whole pounds, `>= 0` (the outbound row's `weight_lbs`)
 * @param recyclingPercent fraction recycled, `0..1` (Decimal, string, or number)
 * @throws RecordValidationError on a non-integer/negative weight or an out-of-range
 *         fraction — the DB CHECK fences the stored rate, this fences the inputs.
 */
export function deriveRecyclingSplit(
  weightLbs: number,
  recyclingPercent: Prisma.Decimal | string | number,
): RecyclingSplit {
  if (!Number.isInteger(weightLbs) || weightLbs < 0 || weightLbs > 10_000_000) {
    throw new RecordValidationError(
      `weight_lbs must be a whole number in [0, 10000000] (got ${String(weightLbs)})`,
    );
  }
  const pct = new Prisma.Decimal(recyclingPercent);
  if (pct.isNaN() || pct.lessThan(0) || pct.greaterThan(1)) {
    throw new RecordValidationError(
      `recycling_percent must be a fraction in [0, 1] (got ${pct.toString()})`,
    );
  }
  const recycledLbs = new Prisma.Decimal(weightLbs)
    .times(pct)
    .toDecimalPlaces(0, ROUND_HALF_UP)
    .toNumber();
  // pct ∈ [0,1] and round-half-up guarantee 0 <= recycledLbs <= weightLbs, so the
  // complement is always a valid non-negative pound count that sums exactly.
  const landfilledLbs = weightLbs - recycledLbs;
  return { recycledLbs, landfilledLbs, recyclingPercent: pct.toFixed(4) };
}

// ── Vendor master reads ───────────────────────────────────────────────────────

/** A recycler option the iPad entry surface renders in its vendor picker. */
export interface OutboundVendorOption {
  id: string;
  name: string;
}

/** List active outbound recyclers (name-sorted) for the entry-surface picker. */
export async function listActiveOutboundVendors(): Promise<OutboundVendorOption[]> {
  const vendors = await prisma.outboundVendor.findMany({
    where: { is_active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return vendors;
}

// ── Effective-dated resolver ──────────────────────────────────────────────────

/** Resolved recycling-rate row, coerced to a plain shape. */
export interface ResolvedRecyclingRate {
  id: string;
  vendorId: string;
  commodity: OutboundCommodity;
  recyclingPercent: Prisma.Decimal;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * Normalize a Date to UTC midnight of its calendar day, matching how the
 * `@db.Date` effective columns store dates (mirrors `ruleDateUTC` in the program-
 * rules resolver — avoids the local-timezone off-by-one on date comparisons).
 */
export function rateDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Resolve the `recycling_rates` row in effect for `(vendorId, commodity)` on
 * `onDate`, or `null` when none covers the date (the no-rate case — callers must
 * NOT assume a default). Throws {@link AmbiguousRecyclingRateError} if more than one
 * row covers the date (structurally impossible under the overlap guards; a
 * corruption if it ever happens).
 */
export async function resolveRecyclingRate(
  vendorId: string,
  commodity: OutboundCommodity,
  onDate: Date,
): Promise<ResolvedRecyclingRate | null> {
  const on = rateDateUTC(onDate);
  const covering = await prisma.recyclingRate.findMany({
    where: {
      vendor_id: vendorId,
      commodity,
      effective_from: { lte: on },
      OR: [{ effective_to: null }, { effective_to: { gte: on } }],
    },
    orderBy: { effective_from: 'desc' },
  });
  if (covering.length === 0) return null;
  // Two rows both covering one date means their windows overlap AT that date — a
  // forbidden state. Never pick one silently.
  if (covering.length > 1) {
    throw new AmbiguousRecyclingRateError(vendorId, commodity, onDate, covering.map((r) => r.id));
  }
  const rate = covering[0]!;
  return {
    id: rate.id,
    vendorId: rate.vendor_id,
    commodity: rate.commodity,
    recyclingPercent: rate.recycling_percent,
    effectiveFrom: rate.effective_from,
    effectiveTo: rate.effective_to,
  };
}

// ── Combined derivation (resolver + math) for the entry path + preview ─────────

/** Outcome of deriving an outbound load's stewardship split. Discriminated on `status`. */
export type OutboundRecyclingResult =
  | {
      status: 'derived';
      recycledLbs: number;
      landfilledLbs: number;
      /** Decimal(5,4) string of the fraction applied (durable snapshot). */
      recyclingPercent: string;
      rateId: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
    }
  /** No vendor was supplied — derivation cannot run; fields stay null. */
  | { status: 'no_vendor' }
  /** A vendor was supplied but no rate covers (vendor, commodity, ship_date); fields stay null. */
  | { status: 'no_rate' };

/**
 * Derive the CalRecycle stewardship split for an outbound load from its
 * `(vendor_id, commodity)` against the effective-dated `recycling_rates`. Returns a
 * discriminated result the entry path persists (or leaves null + flagged) and the
 * iPad preview renders. Never assumes a rate.
 */
export async function deriveOutboundRecycling(args: {
  vendorId: string | null;
  commodity: OutboundCommodity;
  shipDate: Date;
  weightLbs: number;
}): Promise<OutboundRecyclingResult> {
  if (!args.vendorId) return { status: 'no_vendor' };
  const rate = await resolveRecyclingRate(args.vendorId, args.commodity, args.shipDate);
  if (!rate) return { status: 'no_rate' };
  const split = deriveRecyclingSplit(args.weightLbs, rate.recyclingPercent);
  return {
    status: 'derived',
    recycledLbs: split.recycledLbs,
    landfilledLbs: split.landfilledLbs,
    recyclingPercent: split.recyclingPercent,
    rateId: rate.id,
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
  };
}

// ── Guarded write path (overlap layer 2 of 3) ─────────────────────────────────

/** A Prisma transaction client (the arg `prisma.$transaction(async (tx) => …)` yields). */
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Reject a proposed `[from, to]` window (to = null → open-ended) that overlaps any
 * existing rate for the same (vendor, commodity). Two half-open windows overlap iff
 * `existing.from <= new.to` AND `existing.to >= new.from` (nulls = ±infinity). MUST
 * run inside a transaction that already holds the per-(vendor, commodity) advisory
 * lock, so the check→insert is race-free.
 */
export async function assertNoRecyclingRateOverlap(
  tx: Tx,
  vendorId: string,
  commodity: OutboundCommodity,
  from: Date,
  to: Date | null,
  excludeRateId?: string,
): Promise<void> {
  const conflicts = await tx.recyclingRate.findMany({
    where: {
      vendor_id: vendorId,
      commodity,
      ...(excludeRateId ? { id: { not: excludeRateId } } : {}),
      // existing.from <= new.to  (when new.to is null the new window is unbounded
      // above, so every existing start qualifies — omit the clause).
      ...(to ? { effective_from: { lte: rateDateUTC(to) } } : {}),
      // existing.to >= new.from  (null existing.to = unbounded above → always qualifies).
      OR: [{ effective_to: null }, { effective_to: { gte: rateDateUTC(from) } }],
    },
    select: { id: true },
  });
  if (conflicts.length > 0) {
    throw new RecyclingRateOverlapError(vendorId, commodity, conflicts.map((c) => c.id));
  }
}

/**
 * Create a `recycling_rates` row through the guarded path: a per-(vendor, commodity)
 * transaction advisory lock closes the check→insert race, then the overlap guard
 * runs, then the row is inserted. This is the ONLY sanctioned way to add a rate
 * (the seed and any future admin endpoint go through it). `from`/`to` are normalized
 * to UTC calendar days.
 */
export async function createRecyclingRate(args: {
  vendorId: string;
  commodity: OutboundCommodity;
  recyclingPercent: Prisma.Decimal | string | number;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  notes?: string | null;
  createdBy?: string | null;
}): Promise<{ id: string }> {
  const pct = new Prisma.Decimal(args.recyclingPercent);
  if (pct.isNaN() || pct.lessThan(0) || pct.greaterThan(1)) {
    throw new RecordValidationError(
      `recycling_percent must be a fraction in [0, 1] (got ${pct.toString()})`,
    );
  }
  const from = rateDateUTC(args.effectiveFrom);
  const to = args.effectiveTo != null ? rateDateUTC(args.effectiveTo) : null;
  if (to && to < from) {
    throw new RecordValidationError(
      `effective_to (${to.toISOString().slice(0, 10)}) must not precede effective_from (${from
        .toISOString()
        .slice(0, 10)})`,
    );
  }
  return prisma.$transaction(async (tx) => {
    // Serialize concurrent inserts for the same (vendor, commodity) so the overlap
    // check and the insert are atomic. hashtext → int4, widened to the bigint
    // pg_advisory_xact_lock signature.
    const lockKey = `${args.vendorId}:${args.commodity}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    await assertNoRecyclingRateOverlap(tx, args.vendorId, args.commodity, from, to);
    const row = await tx.recyclingRate.create({
      data: {
        vendor_id: args.vendorId,
        commodity: args.commodity,
        recycling_percent: pct,
        effective_from: from,
        effective_to: to,
        notes: args.notes ?? null,
        created_by: args.createdBy ?? null,
      },
      select: { id: true },
    });
    return row;
  });
}
