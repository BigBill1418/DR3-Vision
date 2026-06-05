// T-107 (ADR-0020) — VisionTile variant rendering.
//
// VisionTile is a server component (a Link + lucide icon, no client hooks), so
// we render it to static markup and assert the structural contract per variant:
//   - active            → an <a href> to the route, no "Coming soon" pill
//   - active + featured → carries a "New" pill + chartreuse surface, links out
//   - coming-soon       → non-link, aria-disabled, "Coming soon" pill, route NOT
//                         rendered as an href (avoids dead/operator-trap links)

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VisionTile } from './vision-tile';
import type { DashboardTile } from '@/lib/dashboard-tiles';

const base: DashboardTile = {
  key: 'operations',
  label: 'Operations Dashboard',
  description: 'desc',
  icon: 'LayoutDashboard',
  route: '/dashboard',
  status: 'active',
  scope: 'manager+',
};

describe('VisionTile', () => {
  it('active tile renders a link to its route and no coming-soon pill', () => {
    const html = renderToStaticMarkup(<VisionTile tile={base} />);
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('data-status="active"');
    expect(html).not.toMatch(/coming soon/i);
  });

  it('featured tile renders a NEW pill and the chartreuse surface', () => {
    const featured: DashboardTile = {
      ...base,
      key: 'bonus',
      label: 'Bonus Management',
      route: '/bonus',
      featured: true,
    };
    const html = renderToStaticMarkup(<VisionTile tile={featured} />);
    expect(html).toContain('href="/bonus"');
    expect(html).toContain('data-featured="true"');
    expect(html).toMatch(/>New</);
    expect(html).toContain('bg-dr3-chartreuse');
  });

  it('coming-soon tile is non-interactive and exposes no href', () => {
    const soon: DashboardTile = {
      ...base,
      key: 'mrc-api',
      label: 'MRC API Integration',
      route: '#',
      status: 'coming-soon',
    };
    const html = renderToStaticMarkup(<VisionTile tile={soon} />);
    expect(html).toContain('data-status="coming-soon"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toMatch(/coming soon/i);
    expect(html).not.toContain('href=');
  });
});
