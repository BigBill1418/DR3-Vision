// ADR-0041 (capture half) — the B8 event ancillary-cost aggregate. Proves the
// five-term sum (driver + labor + mileage + per diem + misc), null-as-0, and that
// freight is DELIBERATELY excluded (it is a distinct B8 term).

import { describe, it, expect } from 'vitest';
import { eventMiscCents, type EventCostRow } from './types';

function row(over: Partial<EventCostRow>): EventCostRow {
  return {
    id: 'e1',
    siteId: 's1',
    eventDate: new Date('2026-06-15T00:00:00Z'),
    freightCents: null,
    driverWagesCents: null,
    laborWagesCents: null,
    mileageCents: null,
    perDiemCents: null,
    miscCents: null,
    ...over,
  };
}

describe('eventMiscCents — §3.1 B8 ancillary total', () => {
  it('sums the five ancillary terms', () => {
    expect(
      eventMiscCents(
        row({
          driverWagesCents: 31250,
          laborWagesCents: 18000,
          mileageCents: 5000,
          perDiemCents: 27500,
          miscCents: 250,
        }),
      ),
    ).toBe(82000);
  });

  it('treats every null term as 0', () => {
    expect(eventMiscCents(row({}))).toBe(0);
    expect(eventMiscCents(row({ miscCents: 500 }))).toBe(500);
  });

  it('EXCLUDES freight — freight is a distinct B8 term, never folded into the misc total', () => {
    expect(eventMiscCents(row({ freightCents: 92500, driverWagesCents: 100 }))).toBe(100);
  });
});
