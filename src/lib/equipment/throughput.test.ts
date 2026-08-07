// ADR-0079 (supersedes ADR-0044 D2) — throughput provider tests.
//
// The pure math (run-hour from ENTERED hours, the retained legacy rate, rolling
// windows over unrecorded days, monthly cost grouping, pocketcoil overlay shape)
// is exercised directly; the aggregator runs against a mocked Prisma to prove it
// reads the manager's entered days and NOT the floor-wide close.
//
// The aggregator fixtures use the real production magnitudes — Woodland's floor
// closed 1,063 units on 2026-08-06 — so a regression to the derived source shows
// up in a failure message as that exact number rather than as an `undefined`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const MACHINE = { id: 'eq-terex-1', display_name: 'Terex' };

/** The ADR-0077 identity-rule where-clause the resolver must issue. */
interface EquipmentWhere {
  site_id: string;
  category: string;
  is_active: boolean;
  merged_into_id: null;
  links: { some: Record<string, never> };
}

const store = {
  closes: [] as {
    production_date: Date;
    stripped_program: Prisma.Decimal;
    stripped_non_program: Prisma.Decimal;
    pocketcoil_estimate: number | null;
  }[],
  events: [] as {
    event_date: Date;
    kind: string;
    hours_down: Prisma.Decimal | null;
    cost_cents: number | null;
  }[],
  /** ADR-0079 — the manager's ENTERED days. Real `Prisma.Decimal` run hours. */
  entered: [] as {
    throughput_date: Date;
    units_processed: number;
    run_hours: Prisma.Decimal;
  }[],
  /** null ⇒ the site has no registered machine (Eugene's shape). */
  machine: MACHINE as { id: string; display_name: string } | null,
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
    // ADR-0077 identity rule — the resolver must ask for the machine by its
    // EVIDENCE (terex category + active + not merged away + has AP links), never
    // by a literal id. Asserted here so a future edit that hardcodes `7e35a4aa`
    // fails this suite rather than shipping.
    equipment: {
      findFirst: async ({ where }: { where: EquipmentWhere }) => {
        expect(where.category).toBe('terex');
        expect(where.is_active).toBe(true);
        expect(where.merged_into_id).toBeNull();
        expect(where.links).toEqual({ some: {} });
        return store.machine;
      },
    },
    equipmentDailyThroughput: {
      findMany: async ({
        where,
      }: {
        where: { equipment_id: string; voided_at: null; throughput_date: { gte: Date; lte: Date } };
      }) => {
        // Scoped to the resolved machine row and never to a voided entry.
        expect(where.equipment_id).toBe(MACHINE.id);
        expect(where.voided_at).toBeNull();
        return store.entered.filter(
          (e) =>
            e.throughput_date.getTime() >= where.throughput_date.gte.getTime() &&
            e.throughput_date.getTime() <= where.throughput_date.lte.getTime(),
        );
      },
    },
  },
}));

import {
  ASSUMED_DAY_HOURS,
  ASSUMED_DAY_HOURS_LABEL,
  TEREX_CAPTURE_CUTOVER_ISO,
  type DayInput,
  legacyDerivedUnitsPerRunHour,
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

describe('unitsPerRunHour (ADR-0079 — REAL hours, not the 8h assumption)', () => {
  it('divides entered units by entered run hours', () => {
    // 160 units in 5 real hours → 32/hr. Under the superseded ADR-0044 formula
    // this same day produced NOTHING (no downtime recorded ⇒ null), which is why
    // the rate was invisible on a machine whose hours_down was never once written.
    expect(unitsPerRunHour(160, 5)).toBe(32);
    expect(unitsPerRunHour(150, 7.5)).toBe(20);
  });

  it('does NOT use the 8h assumption — the rate tracks the hours entered', () => {
    // The falsification that matters: if the denominator were still
    // `ASSUMED_DAY_HOURS − hoursDown`, 160 units could never divide by 5 to 32.
    // Pin it against the constant so a silent reversion is loud.
    expect(unitsPerRunHour(160, ASSUMED_DAY_HOURS)).toBe(20); // 160/8, only because 8 was ENTERED
    expect(unitsPerRunHour(160, 4)).toBe(40); // 160/4 — NOT 160/(8−4)=40 by coincidence…
    expect(unitsPerRunHour(160, 2)).toBe(80); // …so here the two formulas diverge: 8−2=6 ⇒ 26.67
  });

  it('is null when either figure is missing, or the hours are not positive', () => {
    expect(unitsPerRunHour(null, 4)).toBeNull();
    expect(unitsPerRunHour(160, null)).toBeNull();
    expect(unitsPerRunHour(160, 0)).toBeNull(); // no divide-by-zero / Infinity
    expect(unitsPerRunHour(160, -1)).toBeNull();
  });

  it('keeps a recorded ZERO as a real rate of 0 — absence is the null, not the value', () => {
    expect(unitsPerRunHour(0, 6)).toBe(0);
  });
});

describe('legacyDerivedUnitsPerRunHour (ADR-0079 D5 — retained, not live)', () => {
  it('still computes the superseded ADR-0044 rate for a future cross-check', () => {
    expect(legacyDerivedUnitsPerRunHour(160, 4)).toBe(40); // 160 / (8 − 4)
    expect(ASSUMED_DAY_HOURS).toBe(8);
    expect(ASSUMED_DAY_HOURS_LABEL).toBe('assumed_day_hours');
  });

  it('is null without downtime, and never divides by a non-positive window', () => {
    expect(legacyDerivedUnitsPerRunHour(160, null)).toBeNull();
    expect(legacyDerivedUnitsPerRunHour(160, 0)).toBeNull();
    expect(legacyDerivedUnitsPerRunHour(160, 8)).toBeNull();
    expect(legacyDerivedUnitsPerRunHour(160, 9)).toBeNull();
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
  it('layers run-hour + 7/30 means off the ENTERED figures', () => {
    const s = buildDailySeries([
      {
        dateISO: '2026-07-01',
        unitsDay: 160,
        runHours: 8,
        derivedFloorUnits: 1063,
        hoursDown: null,
        pocketcoilEstimate: 12,
      },
      {
        dateISO: '2026-07-02',
        unitsDay: 120,
        runHours: 4,
        derivedFloorUnits: 1045,
        hoursDown: 4,
        pocketcoilEstimate: null,
      },
      {
        dateISO: '2026-07-03',
        unitsDay: null,
        runHours: null,
        derivedFloorUnits: 1108,
        hoursDown: null,
        pocketcoilEstimate: null,
      },
    ]);
    expect(s[0]!.unitsPerRunHour).toBe(20); // 160 / 8 entered hours
    expect(s[1]!.unitsPerRunHour).toBe(30); // 120 / 4 entered hours
    expect(s[0]!.pocketcoilEstimate).toBe(12);

    // The unrecorded day is null, and it is NOT the floor number sitting right
    // beside it on the same input row.
    expect(s[2]!.unitsDay).toBeNull();
    expect(s[2]!.unitsPerRunHour).toBeNull();
    expect(s[2]!.derivedFloorUnits).toBe(1108); // retained, latent, not throughput

    // Rolling means skip the null day rather than counting it as a zero.
    expect(s[1]!.mean7).toBe(140); // (160+120)/2
    expect(s[2]!.mean7).toBe(140); // still (160+120)/2 — the gap is skipped, not 0
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
    store.entered.length = 0;
    store.machine = MACHINE;
  });

  // ────────────────────────────────────────────────────────────────
  // ADR-0079 D3 — the entered number IS the throughput.
  //
  // These use the real production magnitudes on purpose. Woodland's floor closed
  // 1,063 units on 2026-08-06 (769 program + 294 non-program) and the old code
  // called that the Terex's day. A single machine's real day is a small fraction
  // of it, so if a test ever sees ~1,063 come out of `unitsDay`, the floor-wide
  // derivation has come back.
  // ────────────────────────────────────────────────────────────────
  describe('entered replaces derived (ADR-0079 D3)', () => {
    it('reads the MANAGER-ENTERED units, not stripped_program + stripped_non_program', async () => {
      store.closes.push({
        production_date: new Date('2026-08-06T00:00:00Z'),
        stripped_program: dec(769),
        stripped_non_program: dec(294), // ⇒ derived floor = 1063
        pocketcoil_estimate: null,
      });
      store.entered.push({
        throughput_date: new Date('2026-08-06T00:00:00Z'),
        units_processed: 212,
        run_hours: dec(6.5),
      });

      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-08-06', windowDays: 1 });
      const day = t.daily.find((d) => d.dateISO === '2026-08-06')!;

      expect(day.unitsDay).toBe(212);
      expect(day.unitsDay).not.toBe(1063); // the floor's number is not the machine's
      expect(day.runHours).toBe(6.5);
      // Real hours drive the rate: 212 / 6.5. The superseded formula would have
      // produced null here (no downtime recorded at all).
      expect(day.unitsPerRunHour).toBeCloseTo(212 / 6.5, 10);
      // …and the floor number is still computable, just not the throughput.
      expect(day.derivedFloorUnits).toBe(1063);
      expect(t.machine).toEqual({ id: MACHINE.id, displayName: 'Terex' });
      expect(t.summary.recordedDays).toBe(1);
      expect(t.summary.last7UnitsPerDay).toBe(212);
    });

    it('a RECORDED ZERO stays 0 — the machine ran and produced nothing', async () => {
      store.closes.push({
        production_date: new Date('2026-08-06T00:00:00Z'),
        stripped_program: dec(769),
        stripped_non_program: dec(294),
        pocketcoil_estimate: null,
      });
      store.entered.push({
        throughput_date: new Date('2026-08-06T00:00:00Z'),
        units_processed: 0,
        run_hours: dec(3),
      });
      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-08-06', windowDays: 1 });
      const day = t.daily.find((d) => d.dateISO === '2026-08-06')!;
      // 0 is a VALUE, not an absence — it must not become null, and it must not
      // become the floor's 1063 either.
      expect(day.unitsDay).toBe(0);
      expect(day.unitsDay).not.toBeNull();
      expect(day.unitsPerRunHour).toBe(0);
      expect(t.summary.recordedDays).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ADR-0079 D3 — a missing day is "not recorded". THE falsification.
  //
  // The two failure modes this replaces are both silent, and both would look
  // perfectly reasonable on the screen: render 0 (the machine looks broken) or
  // fall back to the derived floor total (the machine looks like a hero and the
  // office believes a number nobody entered).
  //
  // The floor number is deliberately PRESENT in the store on the unrecorded day,
  // so if the fallback ever returns, these assertions fail naming the real wrong
  // value — 1063 — rather than an `undefined` that proves nothing.
  // ────────────────────────────────────────────────────────────────
  describe('a day with no entry is NOT RECORDED (ADR-0079 D3)', () => {
    it('is null — never 0, and never the derived floor number', async () => {
      // The floor closed on BOTH days; the manager only entered the 5th.
      store.closes.push(
        {
          production_date: new Date('2026-08-05T00:00:00Z'),
          stripped_program: dec(1045),
          stripped_non_program: dec(0), // ⇒ derived floor = 1045
          pocketcoil_estimate: null,
        },
        {
          production_date: new Date('2026-08-06T00:00:00Z'),
          stripped_program: dec(769),
          stripped_non_program: dec(294), // ⇒ derived floor = 1063
          pocketcoil_estimate: null,
        },
      );
      store.entered.push({
        throughput_date: new Date('2026-08-05T00:00:00Z'),
        units_processed: 190,
        run_hours: dec(5),
      });

      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-08-06', windowDays: 2 });
      const unrecorded = t.daily.find((d) => d.dateISO === '2026-08-06')!;

      expect(unrecorded.unitsDay).toBeNull();
      expect(unrecorded.unitsDay).not.toBe(0);
      expect(unrecorded.unitsDay).not.toBe(1063); // the floor-wide fallback
      expect(unrecorded.runHours).toBeNull();
      expect(unrecorded.unitsPerRunHour).toBeNull();

      // The floor number IS available on that day — proving the null above is a
      // deliberate refusal to use it, not merely missing data.
      expect(unrecorded.derivedFloorUnits).toBe(1063);

      // The rolling mean skips the unrecorded day rather than averaging in a 0
      // (which would read 95) or the floor total (which would read 626.5).
      expect(unrecorded.mean7).toBe(190);
      expect(t.summary.last7UnitsPerDay).toBe(190);
      expect(t.summary.recordedDays).toBe(1);
    });

    it('reports NOTHING when the manager has entered nothing at all', async () => {
      // The floor closed every day in the window — the derived model would have
      // shown a full, healthy chart here. Entered is empty, so the machine's
      // throughput is honestly unknown.
      for (const [d, p, n] of [
        ['2026-08-04', 984, 79],
        ['2026-08-05', 1045, 0],
        ['2026-08-06', 769, 294],
      ] as const) {
        store.closes.push({
          production_date: new Date(`${d}T00:00:00Z`),
          stripped_program: dec(p),
          stripped_non_program: dec(n),
          pocketcoil_estimate: null,
        });
      }

      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-08-06', windowDays: 3 });

      expect(t.daily.every((d) => d.unitsDay === null)).toBe(true);
      expect(t.summary.last7UnitsPerDay).toBeNull();
      expect(t.summary.last30UnitsPerDay).toBeNull();
      expect(t.summary.recordedDays).toBe(0);
      // Every one of those floor totals is right there and refused.
      expect(t.daily.map((d) => d.derivedFloorUnits)).toEqual([1063, 1045, 1063]);
    });

    it('a site with no registered machine reports not-recorded, not the floor total', async () => {
      // Eugene's shape: closes may exist, but there is no machine, so there is no
      // machine throughput. The old code would have relabelled the floor's output.
      store.machine = null;
      store.closes.push({
        production_date: new Date('2026-08-06T00:00:00Z'),
        stripped_program: dec(769),
        stripped_non_program: dec(294),
        pocketcoil_estimate: null,
      });
      const t = await computeEquipmentThroughput('S2', { nowISO: '2026-08-06', windowDays: 1 });
      expect(t.machine).toBeNull();
      expect(t.daily[0]!.unitsDay).toBeNull();
      expect(t.daily[0]!.derivedFloorUnits).toBe(1063);
      expect(t.summary.last7UnitsPerDay).toBeNull();
    });
  });

  it('joins closes + downtime into a continuous window and derives the summary', async () => {
    store.entered.push(
      {
        throughput_date: new Date('2026-07-04T00:00:00Z'),
        units_processed: 160,
        run_hours: dec(8),
      },
      {
        throughput_date: new Date('2026-07-05T00:00:00Z'),
        units_processed: 120,
        run_hours: dec(4),
      },
    );
    store.closes.push(
      {
        production_date: new Date('2026-07-04T00:00:00Z'),
        stripped_program: dec(150),
        stripped_non_program: dec(10),
        pocketcoil_estimate: 20,
      },
      {
        production_date: new Date('2026-07-05T00:00:00Z'),
        stripped_program: dec(120),
        stripped_non_program: dec(0),
        pocketcoil_estimate: null,
      },
    );
    store.events.push(
      {
        event_date: new Date('2026-07-05T00:00:00Z'),
        kind: 'downtime',
        hours_down: dec(4),
        cost_cents: null,
      },
      {
        event_date: new Date('2026-07-05T00:00:00Z'),
        kind: 'repair',
        hours_down: dec(2),
        cost_cents: 45000,
      },
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
    // repair hours are NOT folded into the downtime bands — only kind=downtime.
    expect(jul5.hoursDown).toBe(4);
    expect(jul5.unitsPerRunHour).toBe(30); // 120 / 4 ENTERED run hours

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
    // ADR-0077 Amendment 2 — an empty window has NOT RECORDED a cost of zero. It
    // has recorded nothing. This assertion previously read `.toBe(0)`, which is
    // the fabricated figure the amendment removes.
    expect(t.summary.totalCostCents).toBeNull();
    expect(t.downtimeBands).toEqual([]);
  });

  // ────────────────────────────────────────────────────────────────
  // ADR-0077 D4 — "not recorded" is not zero.
  //
  // This is the production shape: `equipment_events.hours_down` is NULL on all
  // 68 Terex rows, so this aggregate summed to 0 and the UI rendered "0.0 hrs"
  // — in GREEN on the overview card. The machine had not run flawlessly; nobody
  // had ever measured it.
  //
  // Both directions are pinned, because only one of them is the bug: absence
  // must be null, and a genuine recorded zero must stay 0.
  // ────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────
  // ADR-0077 AMENDMENT 2 — the same rule, finally applied to COST.
  //
  // ADR-0077 D4 fixed this for downtime and explicitly LEFT cost, on the grounds
  // that cost is only partly unpopulated (7 of 68 live events carry one) and was
  // therefore the weaker case. Partly-populated is precisely when a fake zero is
  // most convincing: the column looks alive, so nobody questions the total, and
  // "$0.00" on a maintenance tile reads as "this machine cost us nothing".
  //
  // Both directions are pinned, because only one of them is the bug.
  // ────────────────────────────────────────────────────────────────
  describe('cost absence (ADR-0077 Amendment 2)', () => {
    it('is NULL — not $0.00 — when no event in the window carried a cost', async () => {
      // kind=downtime deliberately: `totalDowntimeHours` only counts downtime
      // events, and the point of the second assertion below is to prove events
      // EXIST in this window.
      store.events.push({
        event_date: new Date('2026-07-04T00:00:00Z'),
        kind: 'downtime',
        hours_down: dec(3),
        cost_cents: null,
      });
      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-07-05', windowDays: 5 });

      // Phrased as a rendered VERDICT so the red names the fabricated money the
      // operator would actually have seen — `expected '$0.00' to be 'not recorded'`
      // — rather than the uninformative `expected 0 to be null`.
      const rendered =
        t.summary.totalCostCents == null
          ? 'not recorded'
          : `$${(t.summary.totalCostCents / 100).toFixed(2)}`;
      expect(rendered).toBe('not recorded');
      expect(t.summary.totalCostCents).toBeNull();

      // …and the downtime on that same event still lands, so this is provably
      // "no cost was recorded", not "there were no events".
      expect(t.summary.totalDowntimeHours).toBe(3);
    });

    it('is 0 — not null — when somebody recorded a genuine zero cost', async () => {
      store.events.push({
        event_date: new Date('2026-07-04T00:00:00Z'),
        kind: 'repair',
        hours_down: null,
        cost_cents: 0,
      });
      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-07-05', windowDays: 5 });

      const rendered =
        t.summary.totalCostCents == null
          ? 'not recorded'
          : `$${(t.summary.totalCostCents / 100).toFixed(2)}`;
      // A warranty repair that genuinely cost nothing is a FACT, and collapsing
      // it into "not recorded" would lose it — the mirror-image error, and the
      // reason presence is decided on the events rather than on a truthy sum.
      expect(rendered).toBe('$0.00');
      expect(t.summary.totalCostCents).toBe(0);
    });

    it('keeps a recorded zero distinct from an absent cost in the SAME window', async () => {
      store.events.push(
        {
          event_date: new Date('2026-07-03T00:00:00Z'),
          kind: 'repair',
          hours_down: null,
          cost_cents: null,
        },
        {
          event_date: new Date('2026-07-04T00:00:00Z'),
          kind: 'repair',
          hours_down: null,
          cost_cents: 0,
        },
      );
      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-07-05', windowDays: 5 });
      // One priced event exists, so the window HAS a recorded cost — and it is 0.
      expect(t.summary.totalCostCents).toBe(0);
    });
  });

  describe('downtime absence (ADR-0077 D4)', () => {
    it('is NULL when no event ever carried an hours_down', async () => {
      store.events.push({
        event_date: new Date('2026-07-04T00:00:00Z'),
        kind: 'downtime',
        hours_down: null,
        cost_cents: 12_000,
      });
      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-07-05', windowDays: 5 });
      expect(t.summary.totalDowntimeHours).toBeNull();
      // …and the cost on that same event still lands, so this is not "no events".
      expect(t.summary.totalCostCents).toBe(12_000);
    });

    it('is 0 — not null — when somebody recorded a zero', async () => {
      store.events.push({
        event_date: new Date('2026-07-04T00:00:00Z'),
        kind: 'downtime',
        hours_down: dec(0),
        cost_cents: null,
      });
      const t = await computeEquipmentThroughput('S1', { nowISO: '2026-07-05', windowDays: 5 });
      expect(t.summary.totalDowntimeHours).toBe(0);
      // The chart bands still drop it — a zero-height band is not a band.
      expect(t.downtimeBands).toEqual([]);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// ADR-0079 Amendment 1 — the cutover boundary.
//
// The original cutover applied "entered replaces derived" to ALL of history, so
// on the day it shipped the chart went blank: 989 close-days at Woodland, 67 of
// them inside the default 90-day window carrying real figures (415..1249), all
// rendered "not recorded". Bill's instruction was that the sheet-era history
// "should have all stayed and just been added to".
//
// Amendment 1 restores it WITHOUT letting the floor's number pass as the
// machine's. Cutover is 2026-08-07, so July days below are legacy by construction.
// ────────────────────────────────────────────────────────────────────────
describe('ADR-0079 Amendment 1 — cutover boundary', () => {
  const legacyDay = (dateISO: string, floor: number): DayInput => ({
    dateISO,
    unitsDay: null,
    runHours: null,
    derivedFloorUnits: floor,
    hoursDown: null,
    pocketcoilEstimate: null,
  });
  const enteredDay = (
    dateISO: string,
    units: number,
    hours: number,
    floor: number | null = null,
  ): DayInput => ({
    dateISO,
    unitsDay: units,
    runHours: hours,
    derivedFloorUnits: floor,
    hoursDown: null,
    pocketcoilEstimate: null,
  });

  it('cutover.legacy-day-renders-derived', () => {
    // 31 July days, every one pre-cutover, every one with a real floor close.
    const days = Array.from({ length: 31 }, (_, i) =>
      legacyDay(`2026-07-${String(i + 1).padStart(2, '0')}`, 1000 + i),
    );
    const s = buildDailySeries(days);

    expect(s).toHaveLength(31);
    expect(s.every((d) => d.source === 'legacy_derived')).toBe(true);
    // The figure is CARRIED, so the chart has something to draw…
    expect(s[0]!.derivedFloorUnits).toBe(1000);
    expect(s[30]!.derivedFloorUnits).toBe(1030);
    // …and it is NOT laundered into unitsDay, which stays the machine's field.
    expect(s.every((d) => d.unitsDay === null)).toBe(true);
    expect(TEREX_CAPTURE_CUTOVER_ISO).toBe('2026-08-07');
  });

  it('cutover.post-cutover-gap-stays-loud', () => {
    // The floor closed on both days. One is before the cutover, one after.
    const s = buildDailySeries([
      legacyDay('2026-08-06', 1063),
      legacyDay('2026-08-08', 1100), // post-cutover, unentered
    ]);

    expect(s[0]!.source).toBe('legacy_derived');
    // The post-cutover day has a derived figure available and REFUSES it.
    expect(s[1]!.source).toBe('not_recorded');
    expect(s[1]!.derivedFloorUnits).toBe(1100);
    expect(s[1]!.unitsDay).toBeNull();
  });

  it('cutover.entered-wins-pre-cutover', () => {
    // A manager backfills a July day. Bill's "just be added to": the addition
    // must BEAT the legacy figure it supersedes, not be ignored for being early.
    const s = buildDailySeries([enteredDay('2026-07-15', 208, 6.5, 1120)]);
    expect(s[0]!.source).toBe('entered');
    expect(s[0]!.unitsDay).toBe(208);
    expect(s[0]!.unitsPerRunHour).toBeCloseTo(208 / 6.5, 10);
    // The floor figure is retained but is no longer what this day shows.
    expect(s[0]!.derivedFloorUnits).toBe(1120);
  });

  it('cutover.boundary-is-constant-not-data', () => {
    // THE regression this constant exists to prevent: a first-entered-day
    // boundary would move when someone backfills, silently re-labelling history.
    const base: DayInput[] = [
      legacyDay('2026-07-01', 1001),
      legacyDay('2026-07-02', 1002),
      legacyDay('2026-07-03', 1003),
      legacyDay('2026-08-08', 1100),
    ];
    const before = buildDailySeries(base).map((d) => d.source);

    // Now insert an EARLIER entered row — the exact backfill that would move a
    // data-derived boundary.
    const withBackfill = [...base];
    withBackfill[1] = enteredDay('2026-07-02', 190, 5, 1002);
    const after = buildDailySeries(withBackfill).map((d) => d.source);

    // Only the backfilled day changes. Every OTHER day is byte-identical.
    expect(after[1]).toBe('entered');
    expect(before[1]).toBe('legacy_derived');
    expect([after[0], after[2], after[3]]).toEqual([before[0], before[2], before[3]]);
    expect([after[0], after[2], after[3]]).toEqual([
      'legacy_derived',
      'legacy_derived',
      'not_recorded',
    ]);
  });

  it('means.no-blending-across-era', () => {
    // One 7-day window straddling the boundary: 4 legacy days then 3 entered.
    const days: DayInput[] = [
      legacyDay('2026-08-03', 1108),
      legacyDay('2026-08-04', 1063),
      legacyDay('2026-08-05', 1045),
      legacyDay('2026-08-06', 1063),
      enteredDay('2026-08-07', 200, 5),
      enteredDay('2026-08-08', 210, 5),
      enteredDay('2026-08-09', 220, 5),
    ];
    const s = buildDailySeries(days);
    const last = s[6]!;

    const enteredMean = (200 + 210 + 220) / 3; // 210
    const legacyMean = (1108 + 1063 + 1045 + 1063) / 4; // 1069.75
    const blended = (1108 + 1063 + 1045 + 1063 + 200 + 210 + 220) / 7; // 701.28…

    // The machine mean averages ONLY the 3 entered days.
    expect(last.mean7).toBeCloseTo(enteredMean, 10);
    // The legacy mean averages ONLY the 4 legacy days.
    expect(s[3]!.legacyMean7).toBeCloseTo(legacyMean, 10);
    // The blend appears NOWHERE. Named explicitly so a red says "701.28".
    for (const d of s) {
      expect(d.mean7).not.toBeCloseTo(blended, 6);
      expect(d.mean30).not.toBeCloseTo(blended, 6);
      expect(d.legacyMean7).not.toBeCloseTo(blended, 6);
      expect(d.legacyMean30).not.toBeCloseTo(blended, 6);
    }
    // Legacy days carry no machine mean, and entered days carry no legacy mean
    // beyond the trailing window — the two series never occupy the same day/field.
    expect(s[0]!.mean7).toBeNull();
    expect(last.legacyMean7).toBeNull();
  });

  it('rate.legacy-has-no-rate', () => {
    // A legacy day has a units figure and NO run hours. Reviving the assumed-8h
    // rate here — even labeled — would publish a fabricated denominator.
    const s = buildDailySeries([legacyDay('2026-07-20', 1063)]);
    expect(s[0]!.source).toBe('legacy_derived');
    expect(s[0]!.unitsPerRunHour).toBeNull();
    expect(s[0]!.runHours).toBeNull();
    // 1063/8 = 132.875 — the number that must never appear.
    expect(s[0]!.unitsPerRunHour).not.toBeCloseTo(1063 / ASSUMED_DAY_HOURS, 6);
  });
});
