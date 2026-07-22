import { describe, expect, it } from 'vitest';
import {
  composeCollectionSiteCount,
  composeProcessing,
  composeTransportation,
  roundCents,
  type ProcessingGenerationInput,
  type TransportationGenerationInput,
} from './generate';
import { InvoiceStructuralError, InvoiceZeroError, type EventCostRow } from './types';

const RATE_CA = 1650; // $16.50
const RATE_OR = 1700; // $17.00

function baseProcessing(over: Partial<ProcessingGenerationInput> = {}): ProcessingGenerationInput {
  return {
    kind: 'or_processing_eom',
    processingRateCents: RATE_OR,
    processingRateRef: { rule_kind: 'processing_rate', id: 'r1' },
    strippedProgramUnits: 100,
    strippedSource: { window: '2026-06' },
    incentiveCentsTotal: 0,
    incentiveUnits: 0,
    incentiveSource: null,
    events: [],
    eventsPending: false,
    ...over,
  };
}

function event(over: Partial<EventCostRow> = {}): EventCostRow {
  return {
    id: 'e1',
    eventDateISO: '2026-06-10',
    customer: 'Acme',
    driverWagesCents: 12500,
    laborWagesCents: 9000,
    mileageCents: 4000,
    perDiemCents: 27500,
    miscCents: 1000,
    freightCents: 50000,
    dr3Hauled: true,
    retracId: null,
    ...over,
  };
}

function amount(comp: { lines: { lineCode: string; amountCents: number }[] }, code: string): number {
  return comp.lines.filter((l) => l.lineCode === code).reduce((a, l) => a + l.amountCents, 0);
}

describe('roundCents', () => {
  it('multiplies half-units by integer cents exactly', () => {
    expect(roundCents(150.5, 1650)).toBe(248325); // 150.5 × 1650
    expect(roundCents(100, 1700)).toBe(170000);
    expect(roundCents(0, 1650)).toBe(0);
  });
});

describe('composeProcessing — OR EOM (B6 only, rate $17, no offset)', () => {
  it('B6 = units × rate; total = B15 with no offset', () => {
    const c = composeProcessing(baseProcessing({ strippedProgramUnits: 200 }));
    expect(amount(c, 'B6')).toBe(200 * RATE_OR);
    expect(c.totalCents).toBe(200 * RATE_OR);
    expect(c.lines.map((l) => l.lineCode)).toEqual(['B6']);
  });
});

describe('composeProcessing — CA EOM (B15 = B6+B7+B8, B22 = B15 − B20 offset)', () => {
  it('renders B6,B7,B8 and a NEGATIVE B22.offset; total = B22 exactly', () => {
    const ev = event();
    const c = composeProcessing(
      baseProcessing({
        kind: 'ca_processing_eom',
        processingRateCents: RATE_CA,
        strippedProgramUnits: 300,
        incentiveCentsTotal: 6000,
        incentiveUnits: 20,
        incentiveSource: { rows: 4 },
        events: [ev],
        midMonthOffsetCents: 150 * RATE_CA,
        midMonthOffsetUnits: 150,
        midMonthOffsetSource: { mid_month_window: '1st-15th' },
      }),
    );
    const b6 = 300 * RATE_CA;
    const b7 = 6000;
    const b8 = 12500 + 9000 + 4000 + 27500 + 1000; // event misc, freight excluded
    const b15 = b6 + b7 + b8;
    const b20 = 150 * RATE_CA;
    expect(amount(c, 'B6')).toBe(b6);
    expect(amount(c, 'B7')).toBe(b7);
    expect(amount(c, 'B8')).toBe(b8);
    expect(amount(c, 'B22.offset')).toBe(-b20); // explicit negative offset
    expect(c.totalCents).toBe(b15 - b20); // B22 exactness
  });

  it('event FREIGHT is excluded from B8 (rides transportation)', () => {
    const c = composeProcessing(
      baseProcessing({ kind: 'ca_processing_eom', processingRateCents: RATE_CA, events: [event({ freightCents: 99999 })] }),
    );
    // B8 must not contain the 99999 freight
    expect(amount(c, 'B8')).toBe(12500 + 9000 + 4000 + 27500 + 1000);
  });
});

describe('composeProcessing — program/non-program split (§8.3)', () => {
  it('attaches program (billable) + non-program (tracked) on every processing kind', () => {
    // OR EOM
    const orEom = composeProcessing(
      baseProcessing({ strippedProgramUnits: 200, strippedNonProgramUnits: 15 }),
    );
    expect(orEom.programUnitsProcessed).toBe(200);
    expect(orEom.nonProgramUnitsProcessed).toBe(15);
    // The billable basis EQUALS the B6 line quantity — MRC pays on program only.
    expect(orEom.programUnitsProcessed).toBe(orEom.lines.find((l) => l.lineCode === 'B6')?.quantity);
    // total is program × rate — the non-program units add nothing to the bill.
    expect(orEom.totalCents).toBe(200 * RATE_OR);

    // Mid-month
    const mid = composeProcessing(
      baseProcessing({
        kind: 'ca_processing_mid_month',
        processingRateCents: RATE_CA,
        strippedProgramUnits: 150,
        strippedNonProgramUnits: 9,
      }),
    );
    expect(mid.programUnitsProcessed).toBe(150);
    expect(mid.nonProgramUnitsProcessed).toBe(9);

    // CA EOM (with offset)
    const caEom = composeProcessing(
      baseProcessing({
        kind: 'ca_processing_eom',
        processingRateCents: RATE_CA,
        strippedProgramUnits: 300,
        strippedNonProgramUnits: 22,
        midMonthOffsetCents: 150 * RATE_CA,
        midMonthOffsetUnits: 150,
        midMonthReferenceInvoiceId: 'mid-1',
      }),
    );
    expect(caEom.programUnitsProcessed).toBe(300);
    expect(caEom.nonProgramUnitsProcessed).toBe(22);
  });

  it('non-program defaults to 0 when the caller omits it', () => {
    const c = composeProcessing(baseProcessing({ strippedProgramUnits: 50 }));
    expect(c.nonProgramUnitsProcessed).toBe(0);
  });
});

describe('composeProcessing — mid-month (B20 only, 1st–15th)', () => {
  it('single B20 line = mid-month units × rate', () => {
    const c = composeProcessing(
      baseProcessing({ kind: 'ca_processing_mid_month', processingRateCents: RATE_CA, strippedProgramUnits: 150 }),
    );
    expect(c.lines.map((l) => l.lineCode)).toEqual(['B20']);
    expect(c.totalCents).toBe(150 * RATE_CA);
  });
});

describe('composeProcessing — zero-window typed error (D6)', () => {
  it('nonzero units but 0¢ charge (rate 0) → InvoiceZeroError with numbers', () => {
    expect(() =>
      composeProcessing(baseProcessing({ processingRateCents: 0, strippedProgramUnits: 175 })),
    ).toThrow(InvoiceZeroError);
    try {
      composeProcessing(baseProcessing({ processingRateCents: 0, strippedProgramUnits: 175 }));
    } catch (e) {
      expect(e).toBeInstanceOf(InvoiceZeroError);
      expect((e as InvoiceZeroError).context.strippedProgramUnits).toBe(175);
    }
  });

  it('0 units + 0¢ is a legitimate empty window, not an error', () => {
    const c = composeProcessing(baseProcessing({ strippedProgramUnits: 0 }));
    expect(c.totalCents).toBe(0);
  });
});

describe('composeProcessing — events-integration pending (D3/D6)', () => {
  it('EOM renders a B8 line at 0¢ with source.pending — never silently absent', () => {
    const c = composeProcessing(baseProcessing({ kind: 'or_processing_eom', eventsPending: true, events: [] }));
    const b8 = c.lines.find((l) => l.lineCode === 'B8');
    expect(b8).toBeDefined();
    expect(b8?.amountCents).toBe(0);
    expect(b8?.source).toMatchObject({ pending: 'events-integration' });
  });
});

describe('composeTransportation — B16 composition with provenance', () => {
  const rentals = [
    { id: 'rent1', locationName: 'Yard A', monthlyRateCents: 30000 },
    { id: 'rent2', locationName: 'Yard B', monthlyRateCents: 120000 },
  ];

  it('CA: freight + event freight + fuel + rentals, per-load refs in source', () => {
    const input: TransportationGenerationInput = {
      kind: 'ca_transportation_eom',
      freightLoads: [
        { loadId: 'L1', cents: 45000, ref: { kind: 'tier', id: 't1' }, dateISO: '2026-06-03' },
        { loadId: 'L2', cents: 52000, ref: { kind: 'override', id: 'o1' }, dateISO: '2026-06-09' },
      ],
      events: [event({ freightCents: 50000 })],
      eventsPending: false,
      fuelLoads: [
        { loadId: 'L1', cents: 1200, applied: true, ref: { rule_id: 'f1', fuel_price_week: '2026-06-01' } },
        { loadId: 'L2', cents: 0, applied: false, ref: { rule_id: 'f1', fuel_price_week: '2026-06-08' } },
      ],
      rentals,
    };
    const c = composeTransportation(input);
    expect(amount(c, 'B16.freight')).toBe(97000);
    expect(amount(c, 'B16.event_freight')).toBe(50000);
    expect(amount(c, 'B16.fuel')).toBe(1200);
    expect(amount(c, 'B16.rentals')).toBe(150000);
    expect(c.totalCents).toBe(97000 + 50000 + 1200 + 150000);
    // per-load freight refs preserved in source
    const freightLine = c.lines.find((l) => l.lineCode === 'B16.freight');
    expect(freightLine?.source).toMatchObject({ loads: [{ load_id: 'L1' }, { load_id: 'L2' }] });
  });

  it('OR: structural guard — passing fuelLoads throws (no fuel on OR)', () => {
    const input: TransportationGenerationInput = {
      kind: 'or_transportation_eom',
      freightLoads: [{ loadId: 'L1', cents: 30000, ref: { kind: 'tier', id: 't9' }, dateISO: '2026-06-03' }],
      events: [],
      eventsPending: false,
      fuelLoads: [{ loadId: 'L1', cents: 500, applied: true, ref: {} }],
      rentals: [],
    };
    expect(() => composeTransportation(input)).toThrow(InvoiceStructuralError);
  });

  it('OR: with no fuelLoads, produces NO fuel line by construction', () => {
    const input: TransportationGenerationInput = {
      kind: 'or_transportation_eom',
      freightLoads: [{ loadId: 'L1', cents: 30000, ref: { kind: 'tier', id: 't9' }, dateISO: '2026-06-03' }],
      events: [],
      eventsPending: false,
      fuelLoads: [],
      rentals,
    };
    const c = composeTransportation(input);
    expect(c.lines.some((l) => l.lineCode === 'B16.fuel')).toBe(false);
    expect(c.totalCents).toBe(30000 + 150000);
  });
});

describe('composeCollectionSiteCount — manual lines only, source.manual', () => {
  it('sums manual lines and stamps manual provenance', () => {
    const c = composeCollectionSiteCount([
      { description: 'Satellite site A — 100 units @ $2.25', quantity: 100, amountCents: 22500, rateRef: { rate_cents: 225 } },
      { description: 'Satellite site B — 40 units @ $2.25', quantity: 40, amountCents: 9000 },
    ]);
    expect(c.totalCents).toBe(31500);
    expect(c.lines.every((l) => (l.source as { manual?: boolean }).manual === true)).toBe(true);
  });
});
