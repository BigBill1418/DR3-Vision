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

const base: FloorInventoryTileData = {
  programOnFloor: 137,
  nonProgramOnFloor: 1152,
  totalOnFloor: 1289,
  anchorPool: 'measured',
  negative: false,
  trailingUnitsPerDay: 237,
  programDaysRemaining: 137 / 237,
  asOfISO: '2026-07-21',
};

describe('FloorInventoryTile', () => {
  it("renders Rick's three pool numbers and links into loads & inventory", () => {
    const html = renderToStaticMarkup(<FloorInventoryTile tile={base} siteCode="eugene" />);
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
    const html = renderToStaticMarkup(<FloorInventoryTile tile={base} siteCode="eugene" />);
    expect(html).toMatch(/&lt; 1 day/);
    expect(html).toContain('>237<');
    expect(html).toContain('units/day');
  });

  it('multi-day projection shows one decimal', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={{ ...base, programDaysRemaining: 2.6, trailingUnitsPerDay: 150 }}
        siteCode="woodland"
      />,
    );
    expect(html).toContain('≈ 2.6 days');
    expect(html).toContain('href="/dashboard/woodland/loads-inventory"');
  });

  it('null projection renders the no-rate copy and omits the pace line', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={{ ...base, programDaysRemaining: null, trailingUnitsPerDay: null }}
        siteCode="eugene"
      />,
    );
    expect(html).toContain('no trailing rate yet');
    expect(html).not.toContain('units/day');
  });

  it('legacy anchor shows the unsplit-anchor badge; measured does not', () => {
    const measured = renderToStaticMarkup(<FloorInventoryTile tile={base} siteCode="eugene" />);
    expect(measured).not.toMatch(/unsplit anchor/i);
    const legacy = renderToStaticMarkup(
      <FloorInventoryTile tile={{ ...base, anchorPool: 'legacy' }} siteCode="eugene" />,
    );
    expect(legacy).toMatch(/unsplit anchor/i);
  });

  it('fractional Decimal(7,1) floors render with one decimal', () => {
    const html = renderToStaticMarkup(
      <FloorInventoryTile
        tile={{ ...base, programOnFloor: 10.5, totalOnFloor: 1162.5 }}
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
  const negative: FloorInventoryTileData = {
    ...base,
    programOnFloor: -2439,
    nonProgramOnFloor: 512,
    totalOnFloor: -1927,
    negative: true,
  };

  // ── FALSIFICATION (tile banner) ───────────────────────────────────────────
  // Verified by hand against the pre-fix component (no `negative` branch): the
  // banner assertion failed with `expected '…' to contain
  // 'data-testid="floor-negative-banner"'`, and the absence assertions failed
  // because the markup really did carry `>-2,439<` in a pool numeral.
  it('renders the banner instead of the pool numerals', () => {
    const html = renderToStaticMarkup(<FloorInventoryTile tile={negative} siteCode="woodland" />);
    expect(html).toContain('data-testid="floor-negative-banner"');
    expect(html).toContain('On-hand is computing negative');
    expect(html).toContain('This figure is not reliable');
  });

  it('does NOT render the negative figures in a value position', () => {
    const html = renderToStaticMarkup(<FloorInventoryTile tile={negative} siteCode="woodland" />);
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
    const html = renderToStaticMarkup(<FloorInventoryTile tile={negative} siteCode="woodland" />);
    expect(html).not.toContain('data-testid="floor-program-days"');
    expect(html).not.toContain('remaining at the current pace');
    expect(html).not.toContain('7-day pace');
  });

  // The control. Every marker claimed absent above is present on a healthy floor,
  // so none of those assertions can be passing for the boring reason.
  it('(control) all of those markers DO render on a healthy floor', () => {
    const html = renderToStaticMarkup(<FloorInventoryTile tile={base} siteCode="woodland" />);
    expect(html).toContain('data-testid="floor-pool-program"');
    expect(html).toContain('data-testid="floor-pool-total"');
    expect(html).toContain('data-testid="floor-program-days"');
    expect(html).toContain('7-day pace');
    expect(html).not.toContain('data-testid="floor-negative-banner"');
  });
});
