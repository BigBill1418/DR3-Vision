// ADR-0064 — the dashboard route-group layout must mount the shared
// back-to-dashboard bar (a link to /) above every dashboard page, inside the
// manager I18nProvider.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/i18n/get-locale', () => ({ getLocale: async () => 'en' }));

import DashboardLayout from './layout';

describe('DashboardLayout (ADR-0064)', () => {
  it('renders a link back to the dashboard (/) above its children', async () => {
    const html = renderToStaticMarkup(
      await DashboardLayout({ children: <div>dashboard page</div> }),
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('Dashboard');
    expect(html).toContain('dashboard page');
  });
});
