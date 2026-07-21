// ADR-0056 (rollup §5.3, Rick Albritton 2026-07-19) — the event-billing math, as
// PURE functions. Mirrors the ADR-0041 `invoices/generate.ts` discipline: every
// function here takes already-resolved, typed inputs + rate constants and returns a
// priced line-item breakdown. No DB, no clock, no I/O — so the money math is
// exhaustively unit-testable. The DB-fetch layer (a future invoice-generator caller)
// resolves the rate constants from `state_program_rules` / `transport_rate_tiers`
// and calls these.
//
// The six components Rick walked through (§5.3):
//   1. Freight, same-day loaded → standard mileage rate (a `same_day` leg).
//   2. Freight, drop + next-day pickup → Event Mile Rate tier, PER LEG (each leg
//      tier-priced separately).
//   3. Labor hours → total Woodland→event→Woodland roundtrip (travel counts as labor).
//   4. Driver wages → ON-SITE time ONLY (drive time already billed under labor; the
//      two never double-count because they read DIFFERENT captured fields).
//   5. Per diem → overnight event days ONLY (0 unless `overnight`; Happy Camp is the
//      rare example).
//   6. IRS mileage → per vehicle, facility→event→facility, at the IRS-guideline rate
//      (NOT the SVDP rate).
//
// FAIL-LOUD RULE (rollup §15 DO-NOTs, mission money-code discipline): a component is
// priced only if it has a billable quantity. When a component IS billable but its
// rate constant is null/unseeded, the computation REFUSES with a typed error — it
// never guesses a rate or silently bills $0. A component with no quantity (no legs,
// zero hours, not overnight, no vehicle miles) contributes 0 and needs no rate.
//
// AGGREGATION IS NOT DONE HERE. The GP invoice presentation (§9) folds
// `eventTransportationCents` into the `MILES 0` line and the labor components into
// `EVENTO`; that mapping is the invoice generator's job (ADR-0056 integration note).
// This module exposes each component separately so the generator composes the lines.

import { resolveEventMileRateCents } from '../billing-rates/event-mile-rate';
import type { ProposedTier } from '../billing-rates/tier-validation';

/** Freight-leg kind (mirrors the `EventLegType` Prisma enum). */
export type EventLegType = 'drop' | 'pickup' | 'same_day';

/** Which event-billing rate constant was requested but is unseeded/null. */
export type EventRateComponent = 'labor' | 'driver' | 'per_diem' | 'irs_mileage';

/** One freight leg awaiting tier pricing (`event_legs` projection). */
export interface EventLegInput {
  legType: EventLegType;
  /** Mileage used for the tier lookup; must be a finite integer ≥ 0. */
  tierLookupMiles: number;
}

/** One event vehicle's IRS mileage (`event_vehicles` projection). */
export interface EventVehicleInput {
  /** Free-text identifier (no vehicles master); carried through for the line note. */
  vehicleLabel: string | null;
  /** Facility→event→facility miles; must be a finite integer ≥ 0. */
  milesDriven: number;
}

/** The billing-relevant projection of a `collection_events` row + its children. */
export interface EventBillingInput {
  /** Freight legs (§5.3 items 1–2). Empty ⇒ no event transportation. */
  legs: readonly EventLegInput[];
  /** Roundtrip Woodland→event→Woodland hours (§5.3 item 3). Null/0 ⇒ no labor. */
  laborHours: number | null;
  /** On-site hours ONLY (§5.3 item 4). Null/0 ⇒ no driver wages. */
  driverOnsiteHours: number | null;
  /** Overnight days on event (§5.3 item 5). Priced only when `overnight`. */
  perDiemDays: number | null;
  /** Flags the rare overnight stay; per diem is 0 unless this is true. */
  overnight: boolean;
  /** Per-vehicle IRS mileage (§5.3 item 6). Empty ⇒ no IRS mileage. */
  vehicles: readonly EventVehicleInput[];
}

/**
 * Resolved event-billing rate constants. `null` means "no `state_program_rules`
 * row in force" — legal ONLY when the matching component is not billable.
 */
export interface EventRateConstants {
  /**
   * CA `transport_rate_tiers` set — the Event Mile Rate zone table (§3.7). Both
   * `same_day` and `drop`/`pickup` legs price against this one set today (ADR-0040
   * D7: no second table). Must be a VALIDATED set (`assertValidTierSet`).
   */
  eventMileTiers: readonly ProposedTier[];
  /** `general_labor_hourly` cents/hour. */
  laborHourlyCents: number | null;
  /** `driver_hourly` cents/hour. */
  driverHourlyCents: number | null;
  /** `per_diem_nightly` cents/night. */
  perDiemNightlyCents: number | null;
  /** `irs_mileage_rate` cents/mile (IRS-guideline, NOT the SVDP rate). */
  irsMileageCentsPerMile: number | null;
}

/** A priced freight leg. */
export interface EventLegLine {
  legType: EventLegType;
  tierLookupMiles: number;
  rateCents: number;
}

/**
 * A full event-billing breakdown, integer cents. Each of the six §5.3 components is
 * a distinct field; `totalCents` is their sum. The GP EVENTO / MILES-0 aggregation
 * (§9) is deliberately NOT applied here — that is the invoice generator's job.
 */
export interface EventBillingBreakdown {
  /** §5.3 items 1–2: each leg tier-priced separately. */
  legs: readonly EventLegLine[];
  /** Σ leg rate → GP "Event Trans"; folds into the `MILES 0` line (§9). */
  eventTransportationCents: number;
  /** §5.3 item 3: roundtrip travel billed as labor. */
  laborWagesCents: number;
  /** §5.3 item 4: on-site time only (no double-count with labor). */
  driverWagesCents: number;
  /** §5.3 item 5: overnight event days only (0 unless `overnight`). */
  perDiemCents: number;
  /** §5.3 item 6: Σ per-vehicle miles × IRS rate. */
  irsMileageCents: number;
  /** Sum of all six components. */
  totalCents: number;
}

/** A rate constant was needed to price a billable component but was null/unseeded. */
export class EventRateUnavailableError extends Error {
  readonly status = 409 as const;
  constructor(readonly component: EventRateComponent) {
    super(
      `event-billing ${component} rate is unseeded (no state_program_rules row in force) ` +
        `but the event has a billable ${component} quantity — refusing to bill (never guess a rate)`,
    );
    this.name = 'EventRateUnavailableError';
  }
}

/**
 * Integer cents for `quantity × rateCents`. Hours are Decimal(5,2), days/miles are
 * integers, and `rateCents` is an integer, so the product carries at most two
 * decimal places and is far below 2^53 — `Math.round` yields the exact cent with no
 * float drift for any real DR3 volume (the `invoices/generate.ts` roundCents rule).
 */
export function roundCents(quantity: number, rateCents: number): number {
  return Math.round(quantity * rateCents);
}

function assertNonNegInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`event-billing: ${label} must be a non-negative integer (got ${value})`);
  }
}

/**
 * Guard a fractional quantity (Decimal(5,2) hours) before it multiplies a rate:
 * reject NaN/Infinity and negatives so a bad capture fails loud instead of producing
 * NaN/negative cents. Fractions are legal (hours are Decimal(5,2)), so this does NOT
 * require an integer — cf. {@link assertNonNegInt} for whole-unit fields.
 */
function assertNonNegFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `event-billing: ${label} must be a finite non-negative number (got ${value})`,
    );
  }
}

/**
 * Price every freight leg against the CA Event Mile Rate tier set (§5.3 items 1–2).
 * Each leg resolves independently via {@link resolveEventMileRateCents}, which throws
 * {@link import('../billing-rates/event-mile-rate').EventMileRateOutOfRangeError} for
 * an out-of-range mileage — a freight leg MUST NOT silently bill $0.
 */
export function priceEventLegs(
  legs: readonly EventLegInput[],
  eventMileTiers: readonly ProposedTier[],
): EventLegLine[] {
  return legs.map((leg) => ({
    legType: leg.legType,
    tierLookupMiles: leg.tierLookupMiles,
    rateCents: resolveEventMileRateCents(eventMileTiers, leg.tierLookupMiles),
  }));
}

/**
 * Total per-vehicle IRS mileage cents (§5.3 item 6): Σ miles × IRS cents/mile.
 * Refuses ({@link EventRateUnavailableError}) when any vehicle drove miles but the
 * IRS rate is unseeded. Vehicles with 0 miles contribute nothing.
 */
export function computeIrsMileageCents(
  vehicles: readonly EventVehicleInput[],
  irsMileageCentsPerMile: number | null,
): number {
  const totalMiles = vehicles.reduce((acc, v) => {
    assertNonNegInt(v.milesDriven, 'vehicle miles_driven');
    return acc + v.milesDriven;
  }, 0);
  if (totalMiles === 0) return 0;
  if (irsMileageCentsPerMile == null) throw new EventRateUnavailableError('irs_mileage');
  return roundCents(totalMiles, irsMileageCentsPerMile);
}

/**
 * Compute the full event-billing breakdown from a captured event + resolved rate
 * constants. PURE. Fail-loud on any billable component whose rate is unseeded, and
 * on an out-of-range freight leg. Driver wages read ONLY `driverOnsiteHours`, never
 * `laborHours`, so labor and driver-wage cannot double-count the drive time.
 */
export function computeEventBilling(
  input: EventBillingInput,
  rates: EventRateConstants,
): EventBillingBreakdown {
  const legs = priceEventLegs(input.legs, rates.eventMileTiers);
  const eventTransportationCents = legs.reduce((acc, l) => acc + l.rateCents, 0);

  const laborHours = input.laborHours ?? 0;
  assertNonNegFinite(laborHours, 'laborHours');
  const laborWagesCents =
    laborHours === 0
      ? 0
      : rates.laborHourlyCents == null
        ? throwRate('labor')
        : roundCents(laborHours, rates.laborHourlyCents);

  const onsiteHours = input.driverOnsiteHours ?? 0;
  assertNonNegFinite(onsiteHours, 'driverOnsiteHours');
  const driverWagesCents =
    onsiteHours === 0
      ? 0
      : rates.driverHourlyCents == null
        ? throwRate('driver')
        : roundCents(onsiteHours, rates.driverHourlyCents);

  // Per diem bills overnight days ONLY (§5.3 item 5). A non-overnight event never
  // bills per diem even if a day count leaked into the capture. `per_diem_days` is an
  // INTEGER column, so the effective value must be a non-negative whole number.
  const perDiemDays = input.overnight ? (input.perDiemDays ?? 0) : 0;
  assertNonNegInt(perDiemDays, 'perDiemDays');
  const perDiemCents =
    perDiemDays === 0
      ? 0
      : rates.perDiemNightlyCents == null
        ? throwRate('per_diem')
        : roundCents(perDiemDays, rates.perDiemNightlyCents);

  const irsMileageCents = computeIrsMileageCents(input.vehicles, rates.irsMileageCentsPerMile);

  return {
    legs,
    eventTransportationCents,
    laborWagesCents,
    driverWagesCents,
    perDiemCents,
    irsMileageCents,
    totalCents:
      eventTransportationCents +
      laborWagesCents +
      driverWagesCents +
      perDiemCents +
      irsMileageCents,
  };
}

function throwRate(component: EventRateComponent): never {
  throw new EventRateUnavailableError(component);
}
