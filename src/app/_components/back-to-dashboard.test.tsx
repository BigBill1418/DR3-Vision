// ADR-0064 — shared back-to-dashboard nav bar.
//
// Contract asserted here:
//   - BackToDashboardBar renders a real <a href="/"> to the Vision Dashboard
//   - it carries a ≥44px touch target (min-h-[44px]) for the floor iPads
//   - the accessible name comes through (aria-label)
//   - BackToDashboardNav resolves the label/aria from the manager dictionary
//     via the I18nProvider (EN/ES/UR — CLAUDE.md hard rule #4)

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BackToDashboardBar, BackToDashboardNav } from './back-to-dashboard';
import { I18nProvider } from '@/i18n/provider';
import { getManagerDictionary } from '@/i18n/dictionary';

describe('BackToDashboardBar', () => {
  it('renders a link to the Vision Dashboard (/) with the given label + aria', () => {
    const html = renderToStaticMarkup(
      <BackToDashboardBar label="Dashboard" ariaLabel="Back to dashboard" />,
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('Dashboard');
    expect(html).toContain('aria-label="Back to dashboard"');
  });

  it('provides a >=44px touch target for the floor iPads', () => {
    const html = renderToStaticMarkup(
      <BackToDashboardBar label="Dashboard" ariaLabel="Back to dashboard" />,
    );
    expect(html).toContain('min-h-[44px]');
  });
});

describe('BackToDashboardNav (i18n)', () => {
  it('resolves the English label + aria from the manager dictionary', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" dict={getManagerDictionary('en')}>
        <BackToDashboardNav />
      </I18nProvider>,
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('Dashboard');
    expect(html).toContain('aria-label="Back to dashboard"');
  });

  it('resolves the Spanish strings under locale es', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="es" dict={getManagerDictionary('es')}>
        <BackToDashboardNav />
      </I18nProvider>,
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('Panel');
    expect(html).toContain('Volver al panel');
    // Not the untranslated key (would mean a missing dictionary entry).
    expect(html).not.toContain('nav.back_to_dashboard');
  });
});
