// ADR-0056 — event-billing math. Pure: no DB, builder helpers with Partial overrides
// (the invoices/generate.test.ts style). Exercises each §5.3 component, per-leg tier
// pricing, the driver-vs-labor no-double-count invariant, per-diem-only-when-overnight,
// and fail-loud refusal on every unseeded-but-billable rate constant.

import { describe, it, expect } from 'vitest';
import {
  computeEventBilling,
  priceEventLegs,
  computeIrsMileageCents,
  roundCents,
  EventRateUnavailableError,
  type EventBillingInput,
  type EventRateConstants,
} from './compute';
import { EventMileRateOutOfRangeError } from '../billing-rates/event-mile-rate';
import type { ProposedTier } from '../billing-rates/tier-validation';

// The real seeded CA Event Mile Rate tier set (= transport_rate_tiers CA, §3.7).
const CA_EVENT_MILE_TIERS: ProposedTier[] = [
  { min_miles: 0, max_miles: 25, rate_cents: 42500 },
  { min_miles: 26, max_miles: 50, rate_cents: 60000 },
  { min_miles: 51, max_miles: 100, rate_cents: 92500 },
  { min_miles: 101, max_miles: 200, rate_cents: 145000 },
  { min_miles: 201, max_miles: 300, rate_cents: 200000 },
  { min_miles: 301, max_miles: 400, rate_cents: 250000 },
  { min_miles: 401, max_miles: 500, rate_cents: 300000 },
];

// Stub rate constants — arbitrary but distinct so a mis-wired component is obvious.
const RATES: EventRateConstants = {
  eventMileTiers: CA_EVENT_MILE_TIERS,
  laborHourlyCents: 2500, // $25.00/hr
  driverHourlyCents: 3200, // $32.00/hr
  perDiemNightlyCents: 7500, // $75.00/night
  irsMileageCentsPerMile: 67, // $0.67/mile (IRS-guideline placeholder)
};

function event(over: Partial<EventBillingInput> = {}): EventBillingInput {
  return {
    legs: [],
    laborHours: null,
    driverOnsiteHours: null,
    perDiemDays: null,
    overnight: false,
    vehicles: [],
    ...over,
  };
}

function rates(over: Partial<EventRateConstants> = {}): EventRateConstants {
  return { ...RATES, ...over };
}

describe('component 1–2 — per-leg freight, each tier-priced separately', () => {
  it('prices a single same-day loaded leg at its mileage band', () => {
    const b = computeEventBilling(event({ legs: [{ legType: 'same_day', tierLookupMiles: 40 }] }), rates());
    expect(b.eventTransportationCents).toBe(60000);
    expect(b.legs).toEqual([{ legType: 'same_day', tierLookupMiles: 40, rateCents: 60000 }]);
  });

  it('prices a drop + next-day-pickup as TWO independent legs (each its own band)', () => {
    const b = computeEventBilling(
      event({
        legs: [
          { legType: 'drop', tierLookupMiles: 40 }, // band 2 → 60000
          { legType: 'pickup', tierLookupMiles: 150 }, // band 4 → 145000
        ],
      }),
      rates(),
    );
    expect(b.legs.map((l) => l.rateCents)).toEqual([60000, 145000]);
    expect(b.eventTransportationCents).toBe(205000); // summed, NOT a single lookup
  });

  it('fails loud on an out-of-range leg mileage (never a silent $0 freight)', () => {
    expect(() => priceEventLegs([{ legType: 'drop', tierLookupMiles: 999 }], CA_EVENT_MILE_TIERS)).toThrow(
      EventMileRateOutOfRangeError,
    );
  });
});

describe('component 3 — labor hours (roundtrip travel billed as labor)', () => {
  it('bills laborHours × laborHourly', () => {
    const b = computeEventBilling(event({ laborHours: 8.5 }), rates());
    expect(b.laborWagesCents).toBe(roundCents(8.5, 2500)); // 21250
  });

  it('bills 0 and needs no rate when laborHours is null', () => {
    const b = computeEventBilling(event({ laborHours: null }), rates({ laborHourlyCents: null }));
    expect(b.laborWagesCents).toBe(0);
  });
});

describe('component 4 — driver wages (on-site ONLY, no double-count with labor)', () => {
  it('bills driverOnsiteHours × driverHourly, IGNORING laborHours', () => {
    // 8h roundtrip labor + 3h on-site. Driver must bill 3h only — never 8h, never 11h.
    const b = computeEventBilling(event({ laborHours: 8, driverOnsiteHours: 3 }), rates());
    expect(b.driverWagesCents).toBe(roundCents(3, 3200)); // 9600, from on-site hours only
    expect(b.laborWagesCents).toBe(roundCents(8, 2500)); // 20000, independent
    // No term reads both fields for the same money: total is the clean sum.
    expect(b.totalCents).toBe(9600 + 20000);
  });
});

describe('component 5 — per diem (overnight days ONLY)', () => {
  it('bills perDiemDays × nightly rate when overnight', () => {
    const b = computeEventBilling(event({ overnight: true, perDiemDays: 2 }), rates());
    expect(b.perDiemCents).toBe(roundCents(2, 7500)); // 15000
  });

  it('bills 0 per diem when NOT overnight even if a day count is present', () => {
    const b = computeEventBilling(event({ overnight: false, perDiemDays: 2 }), rates());
    expect(b.perDiemCents).toBe(0);
  });
});

describe('component 6 — IRS mileage (per vehicle, IRS rate)', () => {
  it('sums per-vehicle miles × IRS cents/mile', () => {
    const b = computeEventBilling(
      event({
        vehicles: [
          { vehicleLabel: 'Truck 1', milesDriven: 120 },
          { vehicleLabel: 'Truck 2', milesDriven: 80 },
        ],
      }),
      rates(),
    );
    expect(b.irsMileageCents).toBe(roundCents(200, 67)); // (120+80) × 67 = 13400
  });

  it('bills 0 and needs no IRS rate when no vehicle drove miles', () => {
    expect(computeIrsMileageCents([{ vehicleLabel: 'idle', milesDriven: 0 }], null)).toBe(0);
  });
});

describe('fail-loud — unseeded-but-billable rate refuses (never a guessed rate)', () => {
  it('refuses labor when laborHours > 0 but laborHourlyCents is null', () => {
    expect(() => computeEventBilling(event({ laborHours: 4 }), rates({ laborHourlyCents: null }))).toThrow(
      EventRateUnavailableError,
    );
  });

  it('refuses driver when on-site hours > 0 but driverHourlyCents is null', () => {
    expect(() =>
      computeEventBilling(event({ driverOnsiteHours: 2 }), rates({ driverHourlyCents: null })),
    ).toThrow(EventRateUnavailableError);
  });

  it('refuses per diem when overnight days > 0 but perDiemNightlyCents is null', () => {
    expect(() =>
      computeEventBilling(event({ overnight: true, perDiemDays: 1 }), rates({ perDiemNightlyCents: null })),
    ).toThrow(EventRateUnavailableError);
  });

  it('refuses IRS mileage when miles > 0 but irsMileageCentsPerMile is null', () => {
    try {
      computeEventBilling(event({ vehicles: [{ vehicleLabel: 'T1', milesDriven: 10 }] }), rates({ irsMileageCentsPerMile: null }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EventRateUnavailableError);
      expect((e as EventRateUnavailableError).component).toBe('irs_mileage');
    }
  });
});

describe('full breakdown — all six components + total', () => {
  it('composes every component into a clean total', () => {
    const b = computeEventBilling(
      event({
        legs: [
          { legType: 'drop', tierLookupMiles: 40 }, // 60000
          { legType: 'pickup', tierLookupMiles: 40 }, // 60000
        ],
        laborHours: 10, // ×2500 = 25000
        driverOnsiteHours: 4, // ×3200 = 12800
        overnight: true,
        perDiemDays: 1, // ×7500 = 7500
        vehicles: [{ vehicleLabel: 'T1', milesDriven: 200 }], // ×67 = 13400
      }),
      rates(),
    );
    expect(b).toMatchObject({
      eventTransportationCents: 120000,
      laborWagesCents: 25000,
      driverWagesCents: 12800,
      perDiemCents: 7500,
      irsMileageCents: 13400,
      totalCents: 120000 + 25000 + 12800 + 7500 + 13400,
    });
  });

  it('an OR / zero-activity event totals 0 with no rates required (§5.3 zero case)', () => {
    const b = computeEventBilling(event(), {
      eventMileTiers: CA_EVENT_MILE_TIERS,
      laborHourlyCents: null,
      driverHourlyCents: null,
      perDiemNightlyCents: null,
      irsMileageCentsPerMile: null,
    });
    expect(b.totalCents).toBe(0);
    expect(b.legs).toEqual([]);
  });
});
