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
    // Featured surface is the logo-keyed cyan treatment (ADR-0008 dark theme):
    // a cyan ring + glow, not the legacy chartreuse fill.
    expect(html).toContain('border-dr3-cyan/45');
  });

  it('production-report tile (ADR-0030) renders an active link to /admin/production-report', () => {
    const productionReport: DashboardTile = {
      ...base,
      key: 'production-report',
      label: 'Production Report',
      description: 'Daily email automation config',
      icon: 'FileSpreadsheet',
      route: '/admin/production-report',
      status: 'active',
      scope: 'super-admin-only',
    };
    const html = renderToStaticMarkup(<VisionTile tile={productionReport} />);
    expect(html).toContain('href="/admin/production-report"');
    expect(html).toContain('data-status="active"');
    expect(html).not.toMatch(/coming soon/i);
    // Icon resolves from the allow-list (FileSpreadsheet is registered), so the
    // tile is not the LayoutDashboard fallback path — an <svg> is present.
    expect(html).toContain('<svg');
  });

  it('ADR-0046 — a tile with a positive badgeCount renders a cyan count pill; condensed sizing (p-4/h-9)', () => {
    const ap: DashboardTile = {
      ...base,
      key: 'ap-approvals',
      label: 'AP Approvals',
      icon: 'FileCheck',
      route: '/dashboard/ops/ap',
      scope: 'ap-approver',
      badgeCount: 3,
    };
    const html = renderToStaticMarkup(<VisionTile tile={ap} />);
    expect(html).toContain('href="/dashboard/ops/ap"');
    expect(html).toContain('aria-label="3 pending"');
    expect(html).toContain('>3<');
    // FileCheck resolves from the allow-list (not the LayoutDashboard fallback).
    expect(html).toContain('<svg');
    // Condensed grid sizing (ADR-0046 tile pass): p-4 padding + h-9 icon chip.
    expect(html).toContain('p-4');
    expect(html).toContain('h-9');
  });

  it('a zero / absent badgeCount renders no count pill', () => {
    const ap: DashboardTile = {
      ...base,
      key: 'ap-approvals',
      label: 'AP Approvals',
      icon: 'FileCheck',
      route: '/dashboard/ops/ap',
      scope: 'ap-approver',
      badgeCount: 0,
    };
    const html = renderToStaticMarkup(<VisionTile tile={ap} />);
    expect(html).not.toContain('aria-label=');
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
