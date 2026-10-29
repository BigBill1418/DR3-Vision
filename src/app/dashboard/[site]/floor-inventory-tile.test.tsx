// Rollup §3 (2026-07-21 handoff, §15 item 5) — FloorInventoryTile rendering.
//
// Server component (a Link, no client hooks), so we render to static markup
// and assert the structural contract: three pool numbers, the deep link into
// the site's loads & inventory surface, the projection line, and the
// unsplit-anchor badge only on legacy anchors.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FloorInventoryTile } from './floor-inventory-tile';
import type { FloorInventoryTileData } from '@/lib/dashboard/floor-inventory-tile';
import { presentOnHand } from '@/lib/inventory/negative-floor';
/**
 * ADR-0143 CH-12 — the loader attaches `presented` (presentOnHand over the same
 * numbers). Fixtures that override the numbers re-derive it the same way, so a
 * test can never show the tile a `presented` that disagrees with its numbers.
 */
function presentTile(
  t: Omit<FloorInventoryTileData, 'presented'> & {
    presented?: FloorInventoryTileData['presented'];
  },
  openException: { id: string; pool: 'program' | 'non_program' } | null = null,
): FloorInventoryTileData {
  return {
    ...t,
    presented: presentOnHand(
      { program: t.programOnFloor, nonProgram: t.nonProgramOnFloor, total: t.totalOnFloor },
      {
        inboundStale: t.negativeCause?.kind === 'intake-stale',
        inboundDaysSince:
          t.negativeCause?.kind === 'intake-stale'
            ? t.negativeCause.inboundDaysSince
            : t.negativeCause?.kind === 'processing-exceeds-inbound' &&
                !t.negativeCause.inboundRecorded
              ? null
              : 0,
        openException,
      },
    ),
  };
}

const base: Omit<FloorInventoryTileData, 'presented'> = {
  programOnFloor: 137,
  nonProgramOnFloor: 1152,
  totalOnFloor: 1289,
  anchorPool: 'measured',
  negative: false,
  negativeCause: null,
  capacity: 3500,
  overCapacity: false,
  pctOfCapacity: 26,
  trailingUnitsPerDay: 237,
  programDaysRemaining: 137 / 237,
  asOfISO: '2026-07-21',
};

describe('FloorInventoryTile', () => {
  it("renders Rick's three pool numbers and links into loads & inventory", () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(base)} siteCode="eugene" />,
    );
    expect(html).toContain('href="/dashboard/eugene/loads-inventory"');
    expect(html).toContain('data-testid="floor-inventory-tile"');
    expect(html).toContain('>137<');
    expect(html).toContain('>1,152<');
    expect(html).toContain('>1,289<');
    expect(html).toContain('data-testid="floor-pool-program"');
    expect(html).toContain('data-testid="floor-pool-non-program"');
    expect(html).toContain('data-testid="floor-pool-total"');
    expect(html).toContain('as of 2026-07-21');
  });

  it('sub-day projection reads "&lt; 1 day"; pace line shows the trailing rate', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(base)} siteCode="eugene" />,
    );
    expect(html).toMatch(/&lt; 1 day/);
    expect(html).toContain('>237<');
    expect(html).toContain('units/day');
  });

  it('multi-day projection shows one decimal', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={presentTile({ ...base, programDaysRemaining: 2.6, trailingUnitsPerDay: 150 })}
        siteCode="woodland"
      />,
    );
    expect(html).toContain('≈ 2.6 days');
    expect(html).toContain('href="/dashboard/woodland/loads-inventory"');
  });

  it('null projection renders the no-rate copy and omits the pace line', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={presentTile({ ...base, programDaysRemaining: null, trailingUnitsPerDay: null })}
        siteCode="eugene"
      />,
    );
    expect(html).toContain('no trailing rate yet');
    expect(html).not.toContain('units/day');
  });

  it('legacy anchor shows the unsplit-anchor badge; measured does not', () => {
    const measured = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(base)} siteCode="eugene" />,
    );
    expect(measured).not.toMatch(/unsplit anchor/i);
    const legacy = renderToStaticMarkup(
      <FloorInventoryTile
        tile={presentTile({ ...base, anchorPool: 'legacy' })}
        siteCode="eugene"
      />,
    );
    expect(legacy).toMatch(/unsplit anchor/i);
  });

  it('fractional Decimal(7,1) floors render with one decimal', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={presentTile({ ...base, programOnFloor: 10.5, totalOnFloor: 1162.5 })}
        siteCode="eugene"
      />,
    );
    expect(html).toContain('>10.5<');
    expect(html).toContain('>1,162.5<');
  });
});

// ── handoff #270 §4a — the floor tile stops rendering an impossible number ───
//
// Same disease as the production report, different surface: the tile printed
// "−2,439" in a 3xl bold numeral because that is what the arithmetic produced.
// A negative floor is not a small floor — it is proof intake is under-fed and
// processing has been subtracted from it anyway.
describe('FloorInventoryTile — negative floor', () => {
  const negative: Omit<FloorInventoryTileData, 'presented'> = {
    ...base,
    programOnFloor: -2439,
    nonProgramOnFloor: 512,
    totalOnFloor: -1927,
    negative: true,
    negativeCause: { kind: 'intake-stale', inboundDaysSince: 13 },
  };

  // ── FALSIFICATION (tile banner) ───────────────────────────────────────────
  // Verified by hand against the pre-fix component (no `negative` branch): the
  // banner assertion failed with `expected '…' to contain
  // 'data-testid="floor-negative-banner"'`, and the absence assertions failed
  // because the markup really did carry `>-2,439<` in a pool numeral.
  it('renders the banner instead of the pool numerals', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(negative)} siteCode="woodland" />,
    );
    expect(html).toContain('data-testid="floor-negative-banner"');
    expect(html).toContain('On-hand is computing negative');
    expect(html).toContain('This figure is not reliable');
  });

  it('does NOT render the negative figures in a value position', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(negative)} siteCode="woodland" />,
    );
    // No pool numerals at all — not the negatives, and not the one pool that
    // happens to be positive (a lone "512" reads as a measured floor).
    expect(html).not.toContain('data-testid="floor-pool-program"');
    expect(html).not.toContain('data-testid="floor-pool-non-program"');
    expect(html).not.toContain('data-testid="floor-pool-total"');
    expect(html).not.toContain('-2,439');
    expect(html).not.toContain('−2,439');
    expect(html).not.toContain('-1,927');
  });

  // "≈ 0 days remaining" derived from a broken pool is another confident-looking
  // number. Suppressed OUTRIGHT rather than CSS-hidden — markup that is merely
  // `display:none` still ships the sentence to anything reading the HTML.
  it('suppresses the days-remaining projection entirely, not just visually', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(negative)} siteCode="woodland" />,
    );
    expect(html).not.toContain('data-testid="floor-program-days"');
    expect(html).not.toContain('remaining at the current pace');
    expect(html).not.toContain('7-day pace');
  });

  // The control. Every marker claimed absent above is present on a healthy floor,
  // so none of those assertions can be passing for the boring reason.
  it('(control) all of those markers DO render on a healthy floor', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(base)} siteCode="woodland" />,
    );
    expect(html).toContain('data-testid="floor-pool-program"');
    expect(html).toContain('data-testid="floor-pool-total"');
    expect(html).toContain('data-testid="floor-program-days"');
    expect(html).toContain('7-day pace');
    expect(html).not.toContain('data-testid="floor-negative-banner"');
  });
});

// BS-10 — the upper bound, rendered.
//
// Woodland's live figure on 2026-09-10 was 11,668 units in a 3,500-unit building
// and every surface printed it as an ordinary quantity for six days.
describe('FloorInventoryTile — over capacity', () => {
  const over: Omit<FloorInventoryTileData, 'presented'> = {
    ...base,
    programOnFloor: 11020,
    nonProgramOnFloor: 648,
    totalOnFloor: 11668,
    capacity: 3500,
    overCapacity: true,
    pctOfCapacity: 333,
  };

  it('shows the banner, the percentage and the cap', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(over)} siteCode="woodland" />,
    );
    expect(html).toContain('floor-over-capacity-banner');
    expect(html).toContain('333%');
    expect(html).toContain('3500');
  });

  it('KEEPS the numbers visible — unlike a negative floor', () => {
    // The distinction is the design: an over-capacity floor may be a real
    // operational emergency, so the figure has to stay readable. A negative floor
    // measures nothing and is replaced.
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(over)} siteCode="woodland" />,
    );
    expect(html).toContain('11,020');
  });

  it('NEGATIVE CONTROL — an in-capacity floor shows no banner and no badge', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(base)} siteCode="eugene" />,
    );
    expect(html).not.toContain('floor-over-capacity-banner');
    expect(html).not.toContain('floor-over-capacity-badge');
  });

  it('a NEGATIVE floor still suppresses the figure and does not double-flag', () => {
    const negative: Omit<FloorInventoryTileData, 'presented'> = {
      ...base,
      programOnFloor: -2439,
      totalOnFloor: -2439,
      negative: true,
      negativeCause: { kind: 'processing-exceeds-inbound', inboundRecorded: false },
      overCapacity: false,
    };
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(negative)} siteCode="eugene" />,
    );
    expect(html).toContain('floor-negative-banner');
    expect(html).not.toContain('floor-over-capacity-banner');
  });
});

// ── 2026-10-08 — the banner names the cause instead of always blaming intake ──
// Each case failed against the pre-fix component, which printed "Intake data is
// incomplete" for every negative floor (Woodland 2026-10-07, intake 0 days old).
describe('FloorInventoryTile — negative floor cause (2026-10-08)', () => {
  const neg = (
    over: Partial<Omit<FloorInventoryTileData, 'presented'>>,
  ): Omit<FloorInventoryTileData, 'presented'> => ({
    ...base,
    negative: true,
    ...over,
  });

  it('CASE 1 pool split → names the program pool, no intake blame, no figures', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={presentTile(
          neg({
            programOnFloor: -147,
            nonProgramOnFloor: 1750,
            totalOnFloor: 1603,
            negativeCause: { kind: 'pool-split', pool: 'program' },
          }),
        )}
        siteCode="woodland"
      />,
    );
    expect(html).toContain('Program on-hand is computing negative while the total is positive.');
    expect(html).toContain('check how non-program units are entered in the daily close');
    expect(html).not.toContain('Intake data is incomplete');
    expect(html).not.toContain('147');
    // ADR-0143 B2 / CH-12 (Bill, 2026-10-29): "hide both pools, keep the total". The
    // total is not in question in case 1; both pool figures stay hidden.
    expect(html).toContain('>1,603<');
    expect(html).not.toContain('data-testid="floor-pool-program"');
    expect(html).not.toContain('data-testid="floor-pool-non-program"');
  });

  it('CASE 2 stale intake → keeps the intake wording with its age', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={presentTile(
          neg({
            programOnFloor: -600,
            totalOnFloor: -500,
            negativeCause: { kind: 'intake-stale', inboundDaysSince: 9 },
          }),
        )}
        siteCode="woodland"
      />,
    );
    expect(html).toContain('On-hand is computing negative.');
    expect(html).toContain('Intake data is incomplete — most recent inbound is 9 days old.');
  });

  it('CASE 3 current intake → processing exceeds recorded inbound, no intake blame', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={presentTile(
          neg({
            programOnFloor: -200,
            totalOnFloor: -150,
            negativeCause: { kind: 'processing-exceeds-inbound', inboundRecorded: true },
          }),
        )}
        siteCode="woodland"
      />,
    );
    expect(html).toContain(
      'More units have been processed than were recorded coming in since the last physical count.',
    );
    expect(html).not.toContain('Intake data is incomplete');
    expect(html).not.toContain('days old');
  });
});

// ── CH-12 (Bill, 2026-10-29): an open exception hides the split on the tile too ──
describe('FloorInventoryTile — open inventory exception (CH-12)', () => {
  const midday = {
    ...base,
    programOnFloor: 138,
    nonProgramOnFloor: 644,
    totalOnFloor: 782,
    programDaysRemaining: 0.6,
  };
  const ex = { id: 'ex-woodland-program', pool: 'program' as const };

  it('mid-day positive pools + open exception → pools hidden, total kept, tile opens the exception, no projection', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(midday, ex)} siteCode="woodland" />,
    );
    expect(html).toContain('data-testid="floor-split-hidden-banner"');
    expect(html).toContain('The program / non-program split is being corrected.');
    expect(html).toContain('>782<');
    expect(html).not.toContain('>138<');
    expect(html).not.toContain('>644<');
    expect(html).not.toContain('data-testid="floor-program-days"');
    expect(html).toContain('href="/dashboard/woodland/inventory-exceptions/ex-woodland-program"');
  });

  it('no exception (resolved) → the split is back and the tile links to loads & inventory', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile tile={presentTile(midday)} siteCode="woodland" />,
    );
    expect(html).toContain('>138<');
    expect(html).toContain('>644<');
    expect(html).not.toContain('floor-split-hidden-banner');
    expect(html).toContain('href="/dashboard/woodland/loads-inventory"');
  });
});
