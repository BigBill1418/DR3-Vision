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
import type { EquipmentThroughput, DailyThroughputPoint } from '@/lib/equipment/throughput';

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
    },
  };
}

function render(t: EquipmentThroughput): string {
  return renderToStaticMarkup(
    <EquipmentClient siteCode="woodland" throughput={t} showTrend showEntry={false} />,
  );
}

/** The `<rect>` markup for one day's bar, by its date. */
function barFor(html: string, dateISO: string): string {
  const m = new RegExp(`<rect[^>]*data-testid="bar-${dateISO}"[^>]*>`).exec(html);
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
