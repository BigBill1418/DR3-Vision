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
