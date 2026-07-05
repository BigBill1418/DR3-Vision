// ADR-0044 D2 — derived-throughput provider tests. The pure math (run-hour incl.
// the labeled 8h assumption, rolling windows over days-without-closes, monthly
// cost grouping, pocketcoil overlay shape) is exercised directly; the aggregator
// is exercised against a mocked Prisma to prove it wires the builders correctly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const store = {
  closes: [] as {
    production_date: Date;
    stripped_program: Prisma.Decimal;
    stripped_non_program: Prisma.Decimal;
    pocketcoil_estimate: number | null;
  }[],
  events: [] as { event_date: Date; kind: string; hours_down: Prisma.Decimal | null; cost_cents: number | null }[],
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    processedUnitsDaily: {
      findMany: async ({ where }: { where: { production_date: { gte: Date; lte: Date } } }) =>
        store.closes.filter(
          (c) =>
            c.production_date.getTime() >= where.production_date.gte.getTime() &&
            c.production_date.getTime() <= where.production_date.lte.getTime(),
        ),
    },
    equipmentEvent: {
      findMany: async ({ where }: { where: { event_date: { gte: Date; lte: Date } } }) =>
        store.events.filter(
          (e) =>
            e.event_date.getTime() >= where.event_date.gte.getTime() &&
            e.event_date.getTime() <= where.event_date.lte.getTime(),
        ),
    },
  },
}));

import {
  ASSUMED_DAY_HOURS,
  ASSUMED_DAY_HOURS_LABEL,
  unitsPerRunHour,
  rollingMean,
  enumerateDaysISO,
  buildDailySeries,
  monthlyCostSeries,
  computeEquipmentThroughput,
} from './throughput';

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

describe('unitsPerRunHour (the labeled 8h assumption)', () => {
  it('divides units/day by (assumed_day_hours − hoursDown)', () => {
    // 160 units, 4h down → 160 / (8 − 4) = 40 units/run-hour
    expect(unitsPerRunHour(160, 4)).toBe(40);
    expect(ASSUMED_DAY_HOURS).toBe(8);
    expect(ASSUMED_DAY_HOURS_LABEL).toBe('assumed_day_hours');
  });

  it('is null on a day without downtime hours (metric only meaningful then)', () => {
    expect(unitsPerRunHour(160, null)).toBeNull();
    expect(unitsPerRunHour(160, 0)).toBeNull();
  });

  it('is null when units are unknown or downtime swallows the whole day', () => {
    expect(unitsPerRunHour(null, 4)).toBeNull();
    expect(unitsPerRunHour(160, 8)).toBeNull(); // run window 0 → not −Infinity/NaN
    expect(unitsPerRunHour(160, 9)).toBeNull();
  });
});

describe('rollingMean', () => {
  it('averages only non-null values in the trailing window', () => {
    expect(rollingMean([10, 20, 30], 2)).toEqual([10, 15, 25]);
  });

  it('skips null days (days without closes) and yields null for an all-null window', () => {
    expect(rollingMean([null, 20, null], 2)).toEqual([null, 20, 20]);
    expect(rollingMean([null, null], 7)).toEqual([null, null]);
  });
});

describe('enumerateDaysISO', () => {
  it('returns an inclusive ascending calendar-day span', () => {
    expect(enumerateDaysISO('2026-07-01', '2026-07-04')).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
    ]);
  });
});

describe('buildDailySeries', () => {
  it('layers run-hour + 7/30 means; run-hour only where downtime exists', () => {
    const s = buildDailySeries([
      { dateISO: '2026-07-01', unitsDay: 160, hoursDown: null, pocketcoilEstimate: 12 },
      { dateISO: '2026-07-02', unitsDay: 120, hoursDown: 4, pocketcoilEstimate: null },
      { dateISO: '2026-07-03', unitsDay: null, hoursDown: null, pocketcoilEstimate: null },
    ]);
    expect(s[0]!.unitsPerRunHour).toBeNull();
    expect(s[1]!.unitsPerRunHour).toBe(30); // 120 / (8−4)
    expect(s[2]!.unitsDay).toBeNull();
    expect(s[1]!.mean7).toBe(140); // (160+120)/2 — the null day is excluded
    expect(s[0]!.pocketcoilEstimate).toBe(12);
  });
});

describe('monthlyCostSeries', () => {
  it('sums cost_cents by calendar month, ascending, ignoring null costs', () => {
    expect(
      monthlyCostSeries([
        { eventDate: new Date('2026-06-10T00:00:00Z'), costCents: 5000 },
        { eventDate: new Date('2026-06-20T00:00:00Z'), costCents: 2500 },
        { eventDate: new Date('2026-07-01T00:00:00Z'), costCents: 9000 },
        { eventDate: new Date('2026-07-02T00:00:00Z'), costCents: null },
      ]),
    ).toEqual([
      { monthISO: '2026-06', costCents: 7500 },
      { monthISO: '2026-07', costCents: 9000 },
    ]);
  });
});

describe('computeEquipmentThroughput (aggregator)', () => {
  beforeEach(() => {
    store.closes.length = 0;
    store.events.length = 0;
  });

  it('joins closes + downtime into a continuous window and derives the summary', async () => {
    store.closes.push(
      { production_date: new Date('2026-07-04T00:00:00Z'), stripped_program: dec(150), stripped_non_program: dec(10), pocketcoil_estimate: 20 },
      { production_date: new Date('2026-07-05T00:00:00Z'), stripped_program: dec(120), stripped_non_program: dec(0), pocketcoil_estimate: null },
    );
    store.events.push(
      { event_date: new Date('2026-07-05T00:00:00Z'), kind: 'downtime', hours_down: dec(4), cost_cents: null },
      { event_date: new Date('2026-07-05T00:00:00Z'), kind: 'repair', hours_down: dec(2), cost_cents: 45000 },
    );

    const t = await computeEquipmentThroughput('S1', { nowISO: '2026-07-05', windowDays: 5 });

    expect(t.windowStartISO).toBe('2026-07-01');
    expect(t.windowEndISO).toBe('2026-07-05');
    expect(t.daily).toHaveLength(5);
    expect(t.assumedDayHoursLabel).toBe('assumed_day_hours');

    const jul4 = t.daily.find((d) => d.dateISO === '2026-07-04')!;
    const jul5 = t.daily.find((d) => d.dateISO === '2026-07-05')!;
    expect(jul4.unitsDay).toBe(160);
    expect(jul5.unitsDay).toBe(120);
    // repair hours are NOT folded into the downtime denominator — only kind=downtime.
    expect(jul5.hoursDown).toBe(4);
    expect(jul5.unitsPerRunHour).toBe(30); // 120 / (8 − 4)

    expect(t.downtimeBands).toEqual([{ dateISO: '2026-07-05', hoursDown: 4 }]);
    expect(t.pocketcoil).toEqual([{ dateISO: '2026-07-04', estimate: 20 }]);
    expect(t.monthlyCost).toEqual([{ monthISO: '2026-07', costCents: 45000 }]);
    expect(t.summary.totalDowntimeHours).toBe(4);
    expect(t.summary.totalCostCents).toBe(45000);
    expect(t.summary.last7UnitsPerDay).toBe(140); // (160+120)/2 across the window
  });

  it('never throws on an empty window — all-null daily series, zeroed summary', async () => {
    const t = await computeEquipmentThroughput('S1', { nowISO: '2026-07-05', windowDays: 3 });
    expect(t.daily.every((d) => d.unitsDay === null && d.unitsPerRunHour === null)).toBe(true);
    expect(t.summary.last7UnitsPerDay).toBeNull();
    expect(t.summary.totalCostCents).toBe(0);
    expect(t.downtimeBands).toEqual([]);
  });
});
