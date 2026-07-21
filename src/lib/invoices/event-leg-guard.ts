// Audit wave-1 P2 (money path) — generation-time refusal for uncosted collection
// events. `event-leg.ts` maps `collection_events` rows onto `EventCostRow` and
// coalesces null `*_cents` → 0 so partially-captured events still total cleanly.
// That coalesce silently zeroes the EVENTO/B8 line and event-freight when an event
// has REAL billable activity (legs / labor or driver hours / overnight per-diem days
// / vehicle miles) but its cost cents were never filled in — the exact silent
// underbill ADR-0056's compute layer was built to refuse (D7).
//
// ADR-0056's `EventRateUnavailableError` refuses when a RATE CONSTANT is unseeded;
// that full `computeEventBilling` wiring is a documented follow-up (seam C-18) and
// stays out of scope here. This is the narrower generation-time guard: for the FLAT
// stored-cents model the generator bills today, refuse when a component is billable
// by quantity but its stored cost is null, rather than emit $0. Pure + typed so it
// unit-tests with no DB (the invoices/generate.ts discipline); `event-leg.ts` builds
// the projection from the row + its leg/vehicle capture and calls the assert.

/** The stored-cents cost components a collection event can leave uncosted. */
export type EventCostComponent = 'freight' | 'labor' | 'driver' | 'per_diem' | 'mileage';

/**
 * The billing-relevant projection of one `collection_events` row (+ its ADR-0056
 * `event_legs` / `event_vehicles` capture counts). Quantities are the billable
 * signal; the paired `*Cents` field being null is the uncosted defect. Decimal hour
 * columns are converted to plain numbers at the DB boundary so this stays pure.
 */
export interface EventCostGuardInput {
  id: string;
  eventDateISO: string;
  customer: string | null;
  /** Count of `event_legs` rows for the event (freight signal, §5.3 items 1–2). */
  legCount: number;
  /** Roundtrip labor hours (§5.3 item 3). */
  laborHours: number | null;
  /** Driver activity hours — on-site (§5.3 item 4) or the legacy `driver_hours`. */
  driverHours: number | null;
  /** Overnight per-diem days (§5.3 item 5); billable only when `overnight`. */
  perDiemDays: number | null;
  /** Flags the overnight stay — per diem is not billable unless true. */
  overnight: boolean;
  /** Count of `event_vehicles` rows that drove miles (IRS mileage signal, item 6). */
  vehicleCount: number;
  /** Informational miles on the flat row — a mileage signal alongside `vehicleCount`. */
  mileage: number | null;
  freightCents: number | null;
  laborWagesCents: number | null;
  driverWagesCents: number | null;
  perDiemCents: number | null;
  mileageCents: number | null;
}

/**
 * A collection event carried billable quantities but one or more of its cost
 * components was never costed (stored cents null), so the flat mapping would bill a
 * silent $0. Refuse rather than persist the zero — the ADR-0033 / ADR-0056-D7 lesson
 * at generation time. Names the event so the operator can find and cost it.
 */
export class EventUncostedError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly context: {
      eventId: string;
      eventDateISO: string;
      customer: string | null;
      uncosted: EventCostComponent[];
    },
  ) {
    const who = context.customer ? ` (${context.customer})` : '';
    super(
      `collection event ${context.eventId}${who} on ${context.eventDateISO} has billable ` +
        `quantities but uncosted ${context.uncosted.join(', ')} — refusing to bill a silent $0 ` +
        `(stored cost cents null; cost the event before invoicing)`,
    );
    this.name = 'EventUncostedError';
  }
}

const positive = (n: number | null): boolean => n != null && n > 0;

/** The components that are billable-by-quantity yet have a null stored cost. */
export function findUncostedComponents(e: EventCostGuardInput): EventCostComponent[] {
  const uncosted: EventCostComponent[] = [];
  if (e.legCount > 0 && e.freightCents == null) uncosted.push('freight');
  if (positive(e.laborHours) && e.laborWagesCents == null) uncosted.push('labor');
  if (positive(e.driverHours) && e.driverWagesCents == null) uncosted.push('driver');
  if (e.overnight && positive(e.perDiemDays) && e.perDiemCents == null) uncosted.push('per_diem');
  if ((e.vehicleCount > 0 || positive(e.mileage)) && e.mileageCents == null) uncosted.push('mileage');
  return uncosted;
}

/** Throw {@link EventUncostedError} if any component is billable-but-uncosted. */
export function assertEventCosted(e: EventCostGuardInput): void {
  const uncosted = findUncostedComponents(e);
  if (uncosted.length > 0) {
    throw new EventUncostedError({
      eventId: e.id,
      eventDateISO: e.eventDateISO,
      customer: e.customer,
      uncosted,
    });
  }
}
