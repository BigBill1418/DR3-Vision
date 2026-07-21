// Audit wave-1 P2 — the uncosted-event guard. Pure: no DB, a builder with Partial
// overrides (the invoices/generate.test.ts style). Covers the three cases the fix
// promises: uncosted-but-billable → typed refusal; fully-costed → no throw; and
// zero-quantity → no refusal (the OR / $0-activity event falls through cleanly).

import { describe, it, expect } from 'vitest';
import {
  assertEventCosted,
  findUncostedComponents,
  EventUncostedError,
  type EventCostGuardInput,
} from './event-leg-guard';

/** A zero-quantity, fully-null event: nothing billable, nothing costed. */
function evt(over: Partial<EventCostGuardInput> = {}): EventCostGuardInput {
  return {
    id: 'evt-1',
    eventDateISO: '2026-06-15',
    customer: 'Woodland',
    legCount: 0,
    laborHours: null,
    driverHours: null,
    perDiemDays: null,
    overnight: false,
    vehicleCount: 0,
    mileage: null,
    freightCents: null,
    laborWagesCents: null,
    driverWagesCents: null,
    perDiemCents: null,
    mileageCents: null,
    ...over,
  };
}

describe('event-leg-guard — zero-quantity event (OR / $0-activity case)', () => {
  it('does not refuse an event with no billable quantities and all-null costs', () => {
    expect(findUncostedComponents(evt())).toEqual([]);
    expect(() => assertEventCosted(evt())).not.toThrow();
  });

  it('treats zero (not just null) quantities as non-billable', () => {
    const e = evt({ laborHours: 0, driverHours: 0, perDiemDays: 0, mileage: 0 });
    expect(() => assertEventCosted(e)).not.toThrow();
  });
});

describe('event-leg-guard — fully-costed event', () => {
  it('does not refuse when every billable component has a stored cost', () => {
    const e = evt({
      legCount: 2,
      laborHours: 4,
      driverHours: 3,
      perDiemDays: 1,
      overnight: true,
      vehicleCount: 1,
      mileage: 120,
      freightCents: 92_500,
      laborWagesCents: 20_000,
      driverWagesCents: 15_000,
      perDiemCents: 7_500,
      mileageCents: 8_040,
    });
    expect(findUncostedComponents(e)).toEqual([]);
    expect(() => assertEventCosted(e)).not.toThrow();
  });

  it('zero-cost (not null) is a costed value — a genuine $0 line is allowed', () => {
    const e = evt({ laborHours: 4, laborWagesCents: 0 });
    expect(() => assertEventCosted(e)).not.toThrow();
  });
});

describe('event-leg-guard — uncosted-but-billable event → typed refusal', () => {
  it('refuses freight when legs exist but freight_cents is null', () => {
    const e = evt({ legCount: 1, freightCents: null });
    expect(() => assertEventCosted(e)).toThrow(EventUncostedError);
    expect(findUncostedComponents(e)).toEqual(['freight']);
  });

  it('refuses labor when labor hours are billed but labor_wages_cents is null', () => {
    expect(findUncostedComponents(evt({ laborHours: 5, laborWagesCents: null }))).toEqual(['labor']);
  });

  it('refuses driver when driver hours are present but driver_wages_cents is null', () => {
    expect(findUncostedComponents(evt({ driverHours: 2, driverWagesCents: null }))).toEqual(['driver']);
  });

  it('refuses mileage from the flat miles signal even without vehicle rows', () => {
    expect(findUncostedComponents(evt({ mileage: 80, mileageCents: null }))).toEqual(['mileage']);
  });

  it('refuses mileage from vehicle rows even when the flat miles column is null', () => {
    expect(findUncostedComponents(evt({ vehicleCount: 1, mileage: null, mileageCents: null }))).toEqual(['mileage']);
  });

  it('lists every uncosted component and names the event in the error', () => {
    const e = evt({
      id: 'evt-happy-camp',
      customer: 'Happy Camp',
      legCount: 2,
      laborHours: 6,
      driverHours: 4,
      perDiemDays: 2,
      overnight: true,
      vehicleCount: 1,
      mileage: 200,
    });
    expect(findUncostedComponents(e)).toEqual(['freight', 'labor', 'driver', 'per_diem', 'mileage']);
    try {
      assertEventCosted(e);
      throw new Error('expected EventUncostedError');
    } catch (err) {
      expect(err).toBeInstanceOf(EventUncostedError);
      const ue = err as EventUncostedError;
      expect(ue.status).toBe(422);
      expect(ue.context.eventId).toBe('evt-happy-camp');
      expect(ue.context.uncosted).toEqual(['freight', 'labor', 'driver', 'per_diem', 'mileage']);
      expect(ue.message).toContain('evt-happy-camp');
      expect(ue.message).toContain('Happy Camp');
      expect(ue.message).toContain('2026-06-15');
    }
  });
});

describe('event-leg-guard — per-diem is billable only on overnight stays', () => {
  it('does not refuse per-diem days when overnight is false (per diem is 0, not owed)', () => {
    expect(findUncostedComponents(evt({ perDiemDays: 3, overnight: false, perDiemCents: null }))).toEqual([]);
  });

  it('refuses per-diem days when overnight is true but per_diem_cents is null', () => {
    expect(findUncostedComponents(evt({ perDiemDays: 3, overnight: true, perDiemCents: null }))).toEqual(['per_diem']);
  });
});
