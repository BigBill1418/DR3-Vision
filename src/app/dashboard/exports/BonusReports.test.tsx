// BonusReports — Reports-area entry points into the existing /bonus surfaces
// (T-013 follow-up, 2026-06-06).
//
// Pure presentation server component, so we render to static markup (same style
// as vision-tile.test.tsx) and assert the link contract: it must point at the
// existing bonus report routes and the existing annual CSV export route, with
// the year threaded into both the annual page and the CSV href.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BonusReports } from './BonusReports';

describe('BonusReports', () => {
  const html = renderToStaticMarkup(<BonusReports year={2026} />);

  it('links to the three existing bonus report surfaces', () => {
    expect(html).toContain('href="/bonus/months"');
    expect(html).toContain('href="/bonus/annual"');
    expect(html).toContain('href="/bonus/employees"');
  });

  it('exposes the existing annual CSV export route for the given year', () => {
    expect(html).toContain('href="/api/bonus/annual/export?year=2026"');
    expect(html).toContain('download="bonus-annual-2026.csv"');
  });

  it('threads the year into the annual summary copy and the CSV label', () => {
    expect(html).toMatch(/totals for 2026/);
    expect(html).toMatch(/Export 2026 CSV/);
  });

  it('carries the bonus-reports section marker', () => {
    expect(html).toContain('data-testid="bonus-reports"');
  });
});
