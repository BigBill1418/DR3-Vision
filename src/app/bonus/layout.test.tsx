// ADR-0064 — the bonus route-group layout must mount the shared
// back-to-dashboard bar (a link to /) above the SiteSwitchBanner + page,
// inside the manager I18nProvider.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/i18n/get-locale', () => ({ getLocale: async () => 'en' }));
// Denied gate → no site-switch banner; keeps the test focused on the nav bar.
vi.mock('@/lib/bonus/access', () => ({
  tryBonusAccess: async () => ({ ok: false, status: 403 }),
}));
// Stub the banner so its server-action import chain (next-auth) stays out of
// the unit test — the denied gate means it never renders anyway.
vi.mock('./SiteSwitchBanner', () => ({ SiteSwitchBanner: () => null }));

import BonusLayout from './layout';

describe('BonusLayout (ADR-0064)', () => {
  it('renders a link back to the dashboard (/) above its children', async () => {
    const html = renderToStaticMarkup(
      await BonusLayout({ children: <div>bonus page</div> }),
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('Dashboard');
    expect(html).toContain('bonus page');
  });
});
