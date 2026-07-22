// ADR-0056 amendment (Addendum A §A.3) — the two-haul-mode gate on event freight.
//
// Mode A (dr3_hauled = true, DR3 hauled): event freight rides
// `event_transportation_total` (the B16.event_freight leaf → MILES 0). Mode B
// (dr3_hauled = false, someone else hauled): freight contributes $0 to MILES 0,
// but the event's LABOR still bills via the EVENTO/B8 line (NOT gated).
//
// Fixture = the June Chico real example (rollup §10): EVENTO $4,235.35, event
// freight $925.

import { describe, expect, it } from 'vitest';
import { composeProcessing, composeTransportation } from './generate';
import { eventMiscCents, type EventCostRow } from './types';

const RATE_CA = 1650;

/** June Chico event: $4,235.35 labor (EVENTO), $925 freight. */
function chico(over: Partial<EventCostRow> = {}): EventCostRow {
  return {
    id: 'chico-2026-06',
    eventDateISO: '2026-06-12',
    customer: 'Chico',
    driverWagesCents: 0,
    laborWagesCents: 423535, // $4,235.35 → the EVENTO aggregate
    mileageCents: 0,
    perDiemCents: 0,
    miscCents: 0,
    freightCents: 92500, // $925 → event_transportation_total (MILES 0)
    dr3Hauled: true,
    retracId: null,
    ...over,
  };
}

function amount(comp: { lines: { lineCode: string; amountCents: number }[] }, code: string): number {
  return comp.lines.filter((l) => l.lineCode === code).reduce((a, l) => a + l.amountCents, 0);
}

function transport(events: readonly EventCostRow[]) {
  return composeTransportation({
    kind: 'ca_transportation_eom',
    freightLoads: [],
    events,
    eventsPending: false,
    fuelLoads: [],
    rentals: [],
  });
}

function processing(events: readonly EventCostRow[]) {
  return composeProcessing({
    kind: 'ca_processing_eom',
    processingRateCents: RATE_CA,
    processingRateRef: { rule_kind: 'processing_rate', id: 'r1' },
    strippedProgramUnits: 100,
    strippedSource: { window: '2026-06' },
    incentiveCentsTotal: 0,
    incentiveUnits: 0,
    incentiveSource: null,
    events,
    eventsPending: false,
  });
}

describe('§A.3 Mode A — DR3 hauled (dr3_hauled = true)', () => {
  it('event freight rides event_transportation_total (B16.event_freight → MILES 0)', () => {
    const c = transport([chico({ dr3Hauled: true })]);
    // The MILES 0 member leaf carries the full $925.
    expect(amount(c, 'B16.event_freight')).toBe(92500);
    // quantity counts the one hauled event.
    expect(c.lines.find((l) => l.lineCode === 'B16.event_freight')?.quantity).toBe(1);
  });

  it('labor still bills via EVENTO/B8 (both sides present in Mode A)', () => {
    const c = processing([chico({ dr3Hauled: true })]);
    expect(amount(c, 'B8')).toBe(423535); // $4,235.35
  });
});

describe('§A.3 Mode B — someone else hauled (dr3_hauled = false)', () => {
  it('freight contributes $0 to event_transportation_total (MILES 0) even with non-zero labor', () => {
    const c = transport([chico({ dr3Hauled: false })]);
    expect(amount(c, 'B16.event_freight')).toBe(0);
    // Line still renders (honest $0, never silently absent) but counts 0 hauled events.
    expect(c.lines.find((l) => l.lineCode === 'B16.event_freight')?.quantity).toBe(0);
  });

  it('labor/EVENTO fires REGARDLESS of dr3_hauled (Mode B keeps its B8)', () => {
    const c = processing([chico({ dr3Hauled: false })]);
    expect(amount(c, 'B8')).toBe(423535); // unchanged — labor is not gated
  });

  it('provenance stamps each event with its dr3_hauled flag', () => {
    const c = transport([chico({ dr3Hauled: false })]);
    const src = c.lines.find((l) => l.lineCode === 'B16.event_freight')?.source as {
      events: { id: string; freight_cents: number; dr3_hauled: boolean }[];
    };
    expect(src.events).toEqual([{ id: 'chico-2026-06', freight_cents: 92500, dr3_hauled: false }]);
  });
});

describe('§A.3 mixed batch — only hauled events reach MILES 0', () => {
  it('sums freight for hauled events only; labor sums for all', () => {
    const hauled = chico({ id: 'a', freightCents: 92500, laborWagesCents: 423535, dr3Hauled: true });
    const notHauled = chico({ id: 'b', freightCents: 40000, laborWagesCents: 100000, dr3Hauled: false });
    const events = [hauled, notHauled];
    // event_transportation_total = hauled freight only = $925 (b's $400 excluded).
    expect(amount(transport(events), 'B16.event_freight')).toBe(92500);
    // EVENTO/B8 = both events' labor = $4,235.35 + $1,000.00.
    expect(amount(processing(events), 'B8')).toBe(423535 + 100000);
    // Sanity: eventMiscCents excludes freight for each row.
    expect(eventMiscCents(hauled)).toBe(423535);
  });
});
