// ADR-0065 — manager app chrome (supersedes the ADR-0064 back-only bar).
//
// Contract asserted here:
//   - a real <a href="/"> back to the Vision Dashboard (never router.back())
//   - a sign-out control, which the manager surface previously did NOT have
//     anywhere: a manager's only way out was clearing cookies
//   - ≥44px touch targets (WCAG 2.5.5 / ADR-0060)
//   - EN/ES/UR resolution through the manager dictionary (hard rule #4)
//   - showBack={false} drops the back pill but keeps sign-out (for `/`)

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManagerChromeBar, ManagerChromeNav, SIGNED_OUT_ROUTE } from './manager-chrome';
import { I18nProvider } from '@/i18n/provider';
import { getManagerDictionary } from '@/i18n/dictionary';

const LABELS = {
  backLabel: 'Dashboard',
  backAriaLabel: 'Back to dashboard',
  signOutLabel: 'Log out',
  signOutAriaLabel: 'Log out of DR3-Vision',
};

describe('ManagerChromeBar', () => {
  it('renders a link to the Vision Dashboard (/) with the given label + aria', () => {
    const html = renderToStaticMarkup(<ManagerChromeBar {...LABELS} />);
    expect(html).toContain('href="/"');
    expect(html).toContain('Dashboard');
    expect(html).toContain('aria-label="Back to dashboard"');
  });

  it('renders a sign-out control (the gap ADR-0064 left open)', () => {
    const html = renderToStaticMarkup(<ManagerChromeBar {...LABELS} />);
    expect(html).toContain('Log out');
    expect(html).toContain('aria-label="Log out of DR3-Vision"');
    expect(html).toContain('<button');
  });

  it('provides >=44px touch targets on both controls', () => {
    const html = renderToStaticMarkup(<ManagerChromeBar {...LABELS} />);
    expect(html.match(/min-h-\[44px\]/g)?.length).toBe(2);
  });

  it('drops the back pill but KEEPS sign-out when showBack is false (used on `/`)', () => {
    const html = renderToStaticMarkup(<ManagerChromeBar {...LABELS} showBack={false} />);
    expect(html).not.toContain('href="/"');
    expect(html).toContain('Log out');
  });

  it('signs out to /login with the confirmation flag, not a bare /login', () => {
    // The flag is what makes /login say "You've been signed out" instead of
    // looking identical to an expired-session bounce.
    expect(SIGNED_OUT_ROUTE).toBe('/login?signedout=1');
  });
});

describe('ManagerChromeNav (i18n)', () => {
  it('resolves the English strings from the manager dictionary', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" dict={getManagerDictionary('en')}>
        <ManagerChromeNav />
      </I18nProvider>,
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('Dashboard');
    expect(html).toContain('aria-label="Back to dashboard"');
    expect(html).toContain('Log out');
  });

  it('resolves the Spanish strings under locale es', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="es" dict={getManagerDictionary('es')}>
        <ManagerChromeNav />
      </I18nProvider>,
    );
    expect(html).toContain('Volver al panel');
    expect(html).toContain('Cerrar sesión');
    // Not the raw keys — that would mean a missing dictionary entry.
    expect(html).not.toContain('nav.back_to_dashboard');
    expect(html).not.toContain('nav.sign_out');
  });

  it('resolves the Urdu strings under locale ur', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="ur" dict={getManagerDictionary('ur')}>
        <ManagerChromeNav />
      </I18nProvider>,
    );
    expect(html).toContain('لاگ آؤٹ');
    expect(html).not.toContain('nav.sign_out');
  });

  it('mirrors the directional chevron under RTL rather than hardcoding "left"', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="ur" dict={getManagerDictionary('ur')}>
        <ManagerChromeNav />
      </I18nProvider>,
    );
    expect(html).toContain('rtl:rotate-180');
  });
});
