// ADR-0079 Amendment 1 — the RENDERED contract for the era boundary.
//
// The logic tests (src/lib/equipment/throughput.test.ts) prove a legacy day is
// classified `legacy_derived` and carries the floor figure. These prove the thing
// that actually protects Bill: that a legacy figure can never REACH THE SCREEN
// looking like the machine's own number.
//
// Server-rendered to static markup (the house pattern from OpsOverviewPanel.test)
// — `showEntry={false}` isolates the trend panel, so no client effects or fetches
// run.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EquipmentClient } from './EquipmentClient';
import { buildDailySeries } from '@/lib/equipment/throughput';
import type {
  DayInput,
  EquipmentThroughput,
  DailyThroughputPoint,
} from '@/lib/equipment/throughput';
import type { TerexLedger } from '@/lib/equipment/terex-ledger';

function point(p: Partial<DailyThroughputPoint> & { dateISO: string }): DailyThroughputPoint {
  return {
    source: 'not_recorded',
    unitsDay: null,
    runHours: null,
    derivedFloorUnits: null,
    hoursDown: null,
    unitsPerRunHour: null,
    pocketcoilEstimate: null,
    mean7: null,
    mean30: null,
    // ADR-0081 — the composition + its label travel WITH every mean.
    mean7Composition: { entered: 0, workbook: 0 },
    mean30Composition: { entered: 0, workbook: 0 },
    mean7Label: null,
    mean30Label: null,
    legacyMean7: null,
    legacyMean30: null,
    ...p,
  };
}

function throughput(daily: DailyThroughputPoint[], recordedDays = 0): EquipmentThroughput {
  return {
    windowStartISO: daily[0]?.dateISO ?? '2026-07-01',
    windowEndISO: daily[daily.length - 1]?.dateISO ?? '2026-08-09',
    assumedDayHours: 8,
    assumedDayHoursLabel: 'assumed_day_hours',
    machine: { id: 'eq-terex-1', displayName: 'Terex' },
    captureCutoverISO: '2026-08-07',
    daily,
    downtimeBands: [],
    monthlyCost: [],
    pocketcoil: [],
    summary: {
      last7UnitsPerDay: null,
      last30UnitsPerDay: null,
      totalDowntimeHours: null,
      totalCostCents: 0,
      recordedDays,
      enteredDays: 0,
      workbookDays: 0,
      last7Label: null,
      last30Label: null,
    },
  };
}

function render(t: EquipmentThroughput, ledger: TerexLedger | null = null): string {
  return renderToStaticMarkup(
    <EquipmentClient
      siteCode="woodland"
      throughput={t}
      showTrend
      showEntry={false}
      ledger={ledger}
    />,
  );
}

/** The `<rect>` markup for one day's bar, by its date. */
function barFor(html: string, dateISO: string): string {
  const m = new RegExp(`<rect[^>]*data-testid="bar-${dateISO}"[^>]*>`).exec(html);
  return m?.[0] ?? '';
}

/** Just the metrics band's markup, so "0.0"/"$0.00" assertions can't match elsewhere. */
function bandOf(html: string): string {
  const m = /<section[^>]*data-testid="terex-metrics-band"[\s\S]*?<\/section>/.exec(html);
  return m?.[0] ?? '';
}

const LEGACY_JULY = point({
  dateISO: '2026-07-20',
  source: 'legacy_derived',
  derivedFloorUnits: 1063,
  legacyMean7: 1063,
});
const ENTERED_AUG = point({
  dateISO: '2026-08-08',
  source: 'entered',
  unitsDay: 212,
  runHours: 6.5,
  unitsPerRunHour: 212 / 6.5,
  mean7: 212,
});

describe('ADR-0079 Amendment 1 — rendered era boundary', () => {
  // ────────────────────────────────────────────────────────────────
  // THE mandatory falsification.
  //
  // Delete the `source` branch in the bar renderer (make every bar solid) and
  // this must go RED naming a legacy bar wearing the entered fill. A green here
  // with the branch removed would mean the test measures nothing.
  // ────────────────────────────────────────────────────────────────
  it('render.legacy-can-never-appear-as-entered', () => {
    const html = render(throughput([LEGACY_JULY, ENTERED_AUG], 1));

    const legacyBar = barFor(html, '2026-07-20');
    const enteredBar = barFor(html, '2026-08-08');
    expect(legacyBar).not.toBe('');
    expect(enteredBar).not.toBe('');

    // The ENTERED bar is solid brand green. That is what "solid" means, always.
    expect(enteredBar).toContain('fill="#8fbf3f"');
    expect(enteredBar).toContain('data-source="entered"');

    // The LEGACY bar is NOT solid — it is hatched and outlined. This is the
    // assertion that fails, naming the solid fill, if the branch is removed.
    expect(legacyBar).toContain('data-source="legacy_derived"');
    expect(legacyBar).toContain('fill="url(#legacyHatch)"');
    expect(legacyBar).not.toContain('fill="#8fbf3f"');
    expect(legacyBar).toContain('stroke-dasharray="2 1.5"');

    // Structural, not tonal: the two bars must not differ only by opacity.
    expect(legacyBar).not.toBe(enteredBar.replace('2026-08-08', '2026-07-20'));

    // The per-bar title says so in words, for anyone who hovers or reads a11y.
    expect(html).toContain(
      '2026-07-20: 1063 units — floor-wide total, not Terex-specific (legacy)',
    );

    // …and the always-visible legend states it without any interaction at all.
    expect(html).toContain('data-testid="legacy-legend"');
    expect(html).toContain('floor-wide processed total');
    expect(html).toContain('before daily capture began 2026-08-07');
    expect(html).toContain('Not machine-specific');
  });

  it('axis.scales-to-legacy', () => {
    // The literal reported bug: with ZERO entered days the axis collapsed and no
    // legacy bar could be drawn on-scale. A lone 1063 legacy day must render a
    // bar of full plot height, not a sliver or an overflow.
    const html = render(throughput([LEGACY_JULY]));
    const bar = barFor(html, '2026-07-20');
    expect(bar).not.toBe('');

    const y = Number(/\by="([\d.]+)"/.exec(bar)?.[1]);
    const height = Number(/\bheight="([\d.]+)"/.exec(bar)?.[1]);
    // PAD_T=8, plotH=170 ⇒ a max-value bar sits at y=8 with height=170.
    expect(y).toBeCloseTo(8, 5);
    expect(height).toBeCloseTo(170, 5);
    // If the axis still scaled off `unitsDay` alone, maxUnits would be 1 and the
    // bar height would be ~1063× the plot — assert it is on-scale, not overflowing.
    expect(height).toBeLessThanOrEqual(170);
    expect(height).toBeGreaterThan(0);
  });

  it('means.recorded-days-disclosed', () => {
    // A mean over 1 of 7 days is not a weekly pace; the tile has to say so.
    const t = throughput([LEGACY_JULY, ENTERED_AUG], 1);
    t.summary.last7UnitsPerDay = 212;
    const html = render(t);
    expect(html).toContain('1 of 7 days recorded');
    expect(html).toContain('1 of 30 days recorded');
  });

  it('renders no legacy legend when nothing legacy is on screen', () => {
    // The legend is a claim about the chart; it must not appear over a chart with
    // no legacy bars in it.
    const html = render(throughput([ENTERED_AUG], 1));
    expect(html).not.toContain('data-testid="legacy-legend"');
    expect(html).not.toContain('floor-wide processed total');
  });

  it('draws NOTHING for a post-cutover gap even when a floor figure exists', () => {
    // `not_recorded` with `derivedFloorUnits` present — the substitution the
    // original cutover refused, and Amendment 1 must not quietly reintroduce.
    const gap = point({
      dateISO: '2026-08-09',
      source: 'not_recorded',
      derivedFloorUnits: 1100,
    });
    const html = render(throughput([ENTERED_AUG, gap], 1));
    expect(barFor(html, '2026-08-09')).toBe('');

    // Scoped to the CHART. The figure legitimately appears elsewhere in the
    // document — the CSV export carries it under the explicitly-named
    // `derived_floor_units_all_sources` column, which is the retained latent
    // cross-check of ADR-0079 D5 and is labeled for exactly what it is. What must
    // never happen is it being DRAWN as this machine's day.
    const svg = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
    expect(svg).not.toBe('');
    expect(svg).not.toContain('1100');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0081 — the workbook source, rendered.
//
// Both tests below drive the REAL `buildDailySeries` rather than hand-writing
// `source`/`mean7` onto fixture points. A hand-written fixture would only test
// the layout I already believe in: it would keep asserting a blended mean even
// if the data layer stopped blending, and it would keep saying `data-source=
// "workbook"` even if `classifyDaySource` stopped producing it. Running the real
// builder means the day's classification and its mean are MEASURED here, and the
// rendering assertions sit on top of a series the production code produced.
// ─────────────────────────────────────────────────────────────────────────────

const WB = (dateISO: string, units: number, runHours: number): DayInput => ({
  dateISO,
  unitsDay: units,
  runHours,
  recordedIsWorkbook: true,
  derivedFloorUnits: null,
  hoursDown: null,
  pocketcoilEstimate: null,
});
const ENT = (dateISO: string, units: number, runHours: number): DayInput => ({
  dateISO,
  unitsDay: units,
  runHours,
  recordedIsWorkbook: false,
  derivedFloorUnits: null,
  hoursDown: null,
  pocketcoilEstimate: null,
});
const LEGACY = (dateISO: string, floorUnits: number): DayInput => ({
  dateISO,
  unitsDay: null,
  runHours: null,
  derivedFloorUnits: floorUnits,
  hoursDown: null,
  pocketcoilEstimate: null,
});

/** Wrap a real series in a throughput whose summary is read OFF that series. */
function throughputFrom(daily: DailyThroughputPoint[]): EquipmentThroughput {
  const last = daily[daily.length - 1]!;
  const t = throughput(daily);
  t.summary.last7UnitsPerDay = last.mean7;
  t.summary.last30UnitsPerDay = last.mean30;
  t.summary.last7Label = last.mean7Label;
  t.summary.last30Label = last.mean30Label;
  t.summary.recordedDays = daily.filter(
    (d) => d.source === 'entered' || d.source === 'workbook',
  ).length;
  t.summary.enteredDays = daily.filter((d) => d.source === 'entered').length;
  t.summary.workbookDays = daily.filter((d) => d.source === 'workbook').length;
  return t;
}

describe('ADR-0081 — the workbook source on screen', () => {
  it('display.combined-mean-correctness', () => {
    // A 7-day window STRADDLING the two real sources: five days that came off
    // the TEREX workbook, then two a manager typed in. Production-plausible
    // magnitudes — this machine runs a couple of hundred units a day, not the
    // 1,000–1,250 the floor-wide legacy proxy carries.
    const daily = buildDailySeries([
      WB('2026-08-01', 198, 7.5),
      WB('2026-08-02', 231, 8),
      WB('2026-08-03', 205, 7),
      WB('2026-08-04', 246, 8.5),
      WB('2026-08-05', 189, 6.5),
      ENT('2026-08-06', 212, 6.5),
      ENT('2026-08-07', 224, 7.25),
    ]);
    const last = daily[daily.length - 1]!;

    // The mean is over BOTH sources. 1505 / 7 = 215.0 exactly.
    const combined = (198 + 231 + 205 + 246 + 189 + 212 + 224) / 7;
    expect(combined).toBe(215);
    expect(last.mean7).toBeCloseTo(combined, 10);
    expect(last.mean7Composition).toEqual({ entered: 2, workbook: 5 });

    const html = render(throughputFrom(daily));
    expect(html).toContain('215.0');

    // …and it is NOT the entered-only mean. This is the assertion that would
    // have caught Am.1 D10's rule surviving into ADR-0081: (212+224)/2 = 218.0.
    const enteredOnly = (212 + 224) / 2;
    expect(enteredOnly).toBe(218);
    expect(html).not.toContain('218.0');

    // A blended figure NEVER reaches the screen without saying what it is
    // blended from — the whole condition on which blending was allowed at all.
    expect(last.mean7Label).toBe('7-day mean — 5 sheet, 2 entered');
    expect(html).toContain('5 sheet, 2 entered');
    expect(html).toContain('7-day mean — 5 sheet, 2 entered');

    // The window's real denominator is still disclosed alongside it.
    expect(html).toContain('7 of 7 days recorded');
  });

  // ────────────────────────────────────────────────────────────────
  // THE mandatory falsification for the workbook source.
  //
  // Collapse the source branch in the bar renderer (drop `isWorkbook`, so every
  // non-legacy bar is solid `#8fbf3f`) and this must go RED holding up the
  // workbook bar's own markup with the ENTERED fill on it. Red naming
  // `undefined` or `''` would only prove a field is missing, not that the
  // machine's sheet history is being passed off as a Vision entry.
  // ────────────────────────────────────────────────────────────────
  it('display.source-visual-guard', () => {
    const daily = buildDailySeries([
      LEGACY('2026-07-20', 1063),
      WB('2026-08-02', 231, 8),
      ENT('2026-08-08', 212, 6.5),
    ]);
    // The classification is the production classifier's, not the fixture's.
    expect(daily.map((d) => d.source)).toEqual(['legacy_derived', 'workbook', 'entered']);

    const html = render(throughputFrom(daily));
    const legacyBar = barFor(html, '2026-07-20');
    const workbookBar = barFor(html, '2026-08-02');
    const enteredBar = barFor(html, '2026-08-08');
    expect(legacyBar).not.toBe('');
    expect(workbookBar).not.toBe('');
    expect(enteredBar).not.toBe('');

    // SOLID ALWAYS MEANS ENTERED.
    expect(enteredBar).toContain('data-source="entered"');
    expect(enteredBar).toContain('fill="#8fbf3f"');

    // STRIPED-AND-STRONG means the machine's own sheet history. It carries the
    // workbook hatch, it is NOT solid, and — unlike the legacy bar — its outline
    // is solid, because its number is real.
    expect(workbookBar).toContain('data-source="workbook"');
    expect(workbookBar).toContain('fill="url(#workbookHatch)"');
    expect(workbookBar).not.toContain('fill="#8fbf3f"');
    expect(workbookBar).not.toContain('stroke-dasharray');
    expect(html).toContain('<pattern id="workbookHatch"');

    // HOLLOW-AND-DASHED is still, only, the floor-wide legacy proxy.
    expect(legacyBar).toContain('data-source="legacy_derived"');
    expect(legacyBar).toContain('fill="url(#legacyHatch)"');
    expect(legacyBar).not.toContain('fill="#8fbf3f"');
    expect(legacyBar).toContain('stroke-dasharray="2 1.5"');

    // The three fills are three distinct things — no two bars differ by tone alone.
    expect(workbookBar).not.toContain('url(#legacyHatch)');
    expect(legacyBar).not.toContain('url(#workbookHatch)');

    // The per-bar title says whose number it is, in words.
    expect(html).toContain(
      '2026-08-02: 231 units — from the Terex workbook (imported sheet history)',
    );

    // …and the ALWAYS-VISIBLE legend says it without any interaction at all.
    expect(html).toContain('data-testid="workbook-legend"');
    expect(html).toContain('this machine&#x27;s own daily numbers');
    expect(html).toContain('read off the TEREX workbook');

    // The legacy legend can no longer call itself "striped" — two opposite
    // things are striped now, and only one of them is hollow and dashed.
    expect(html).toContain('Hollow, dashed-outline bars are the');
    expect(html).toContain('floor-wide processed total');
  });

  it('renders no workbook legend when nothing came from the workbook', () => {
    const daily = buildDailySeries([ENT('2026-08-08', 212, 6.5)]);
    const html = render(throughputFrom(daily));
    expect(html).not.toContain('data-testid="workbook-legend"');
    expect(html).not.toContain('read off the TEREX workbook');
  });

  it('axis.scales-to-workbook', () => {
    // (d) verified rather than assumed: a workbook-only window scales the axis
    // to the workbook maximum. If `displayUnits` returned null for `workbook`,
    // `maxUnits` would collapse to 1 and no bar could be drawn on-scale.
    const daily = buildDailySeries([WB('2026-08-02', 231, 8), WB('2026-08-03', 116, 4)]);
    const tall = barFor(render(throughputFrom(daily)), '2026-08-02');
    const short = barFor(render(throughputFrom(daily)), '2026-08-03');
    // PAD_T=8, plotH=170 ⇒ the max-value bar fills the plot; 116/231 ≈ half.
    expect(Number(/\bheight="([\d.]+)"/.exec(tall)?.[1])).toBeCloseTo(170, 5);
    expect(Number(/\bheight="([\d.]+)"/.exec(short)?.[1])).toBeCloseTo((116 / 231) * 170, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0081 — the metrics band.
//
// Every figure comes from `computeTerexLedger`; the band re-derives none of it.
// These pins are the SAME production figures pinned in
// src/lib/equipment/terex-ledger.test.ts §1/§2 ($77,067.94 confirmed repairs,
// $4,025.36 credited, 202,492¢ of AP). Held in two places on purpose: the ledger
// test proves the compute produces them, this one proves the screen shows them
// unaltered. Drift in either direction goes red.
// ─────────────────────────────────────────────────────────────────────────────

const PROD_REPAIR_CENTS = 7_706_794;
const PROD_CREDITED_CENTS = 402_536;
const PROD_AP_CENTS = 202_492;

function ledgerFixture(
  over: {
    totalRepairCents?: number | null;
    totalCreditedCents?: number | null;
    totalHours?: number | null;
    events?: TerexLedger['maintenance']['events'];
  } = {},
): TerexLedger {
  const events: TerexLedger['maintenance']['events'] = over.events ?? [
    {
      id: 'row-1',
      eventDateISO: '2026-01-14',
      eventDateRaw: '1/14/2026',
      issue: 'Main drive belt shredded',
      measuresTaken: 'Belt replaced',
      estimatedTimeCost: '2 weeks',
      actualRepairCostCents: 118_400,
      amountCreditedCents: null,
    },
    {
      // The live file's real oddity: the cell said "09/16 or 17", which is not a
      // date, so `event_date` is NULL and the raw text is all there is.
      id: 'row-2',
      eventDateISO: null,
      eventDateRaw: '09/16 or 17',
      issue: 'Hydraulic line burst on the infeed',
      measuresTaken: 'Line and fitting replaced',
      estimatedTimeCost: '3 days',
      actualRepairCostCents: 96_250,
      amountCreditedCents: null,
    },
  ];
  return {
    equipment: {
      id: 'eq-terex-1',
      displayName: 'Terex',
      category: 'terex',
      siteId: 'site-woodland',
    },
    maintenance: {
      events,
      totalRepairCents:
        over.totalRepairCents === undefined ? PROD_REPAIR_CENTS : over.totalRepairCents,
      totalCreditedCents:
        over.totalCreditedCents === undefined ? PROD_CREDITED_CENTS : over.totalCreditedCents,
      awaitingAbsorption: events.length === 0,
    },
    ap: {
      invoices: [
        {
          linkId: 'l1',
          requestId: 'req-1',
          receivedAtISO: '2026-03-02T00:00:00.000Z',
          vendor: 'Terex Services',
          amountCents: PROD_AP_CENTS,
          decisionHref: null,
        },
      ],
      totalCents: PROD_AP_CENTS,
      linkedCents: 0,
    },
    downtime: {
      totalHours: over.totalHours === undefined ? null : over.totalHours,
      eventsWithHours: over.totalHours == null ? 0 : 1,
      eventsConsidered: 68,
    },
  };
}

describe('ADR-0081 — the machine metrics band', () => {
  it('metrics.band-matches-ledger-totals', () => {
    const html = render(throughput([ENTERED_AUG], 1), ledgerFixture());
    const band = bandOf(html);
    expect(band).not.toBe('');

    // Byte-match, thousands separators and all — these are the same strings the
    // ledger detail page one click away renders from the same cents.
    expect(band).toContain('$77,067.94');
    expect(band).toContain('$4,025.36');
    expect(band).toContain('$2,024.92');

    // The link through to the full ledger.
    expect(band).toContain('href="/dashboard/woodland/equipment/eq-terex-1"');

    // Last maintenance event: date + issue, with the date AS WRITTEN because the
    // sheet cell was never a date. Never coerced, never blank.
    expect(band).toContain('09/16 or 17');
    expect(band).toContain('Hydraulic line burst on the infeed');
    expect(band).toContain('as written in the sheet — not a parsed date');
  });

  it('metrics.null-is-not-zero', () => {
    // The house rule, at the only place it is easy to break. `hours_down` is
    // NULL on all 68 production Terex events and no confirmed row need carry a
    // cost — neither is a zero.
    const band = bandOf(
      render(
        throughput([ENTERED_AUG], 1),
        ledgerFixture({ totalRepairCents: null, totalCreditedCents: null, totalHours: null }),
      ),
    );
    expect(band).not.toBe('');
    expect(band).toContain('not recorded');
    expect(band).not.toContain('$0.00');
    expect(band).not.toContain('0.0 hrs');
    // A recorded zero is a different fact and DOES render as one.
    const measured = bandOf(render(throughput([ENTERED_AUG], 1), ledgerFixture({ totalHours: 0 })));
    expect(measured).toContain('0.0 hrs');
  });

  it('renders no band at all when the site has no Terex', () => {
    // Eugene. `computeTerexLedger` returns `equipment: null` and the band must
    // vanish rather than paint a machine that does not exist as one with
    // $0.00 of everything.
    const eugene: TerexLedger = {
      equipment: null,
      maintenance: {
        events: [],
        totalRepairCents: null,
        totalCreditedCents: null,
        awaitingAbsorption: true,
      },
      ap: { invoices: [], totalCents: 0, linkedCents: 0 },
      downtime: { totalHours: null, eventsWithHours: 0, eventsConsidered: 0 },
    };
    const html = render(throughput([ENTERED_AUG], 1), eugene);
    expect(bandOf(html)).toBe('');
    expect(html).not.toContain('data-testid="terex-metrics-band"');
  });

  it('says the maintenance log is un-absorbed rather than showing a clean history', () => {
    const band = bandOf(render(throughput([ENTERED_AUG], 1), ledgerFixture({ events: [] })));
    expect(band).toContain('Maintenance log awaiting absorption acceptance.');
    expect(band).toContain('not a machine that has never needed a repair');
  });
});
