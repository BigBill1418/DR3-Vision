// ADR-0065 — operator (iPad) chrome.
//
// The two things Bill asked for specifically, asserted directly:
//   1. the control is labelled "Log Out" (not "Switch user")
//   2. it is present on EVERY screen an operator can reach with a session —
//      previously it existed on only 2 of the 9 operator screens
//
// Plus the constraint that makes it correct rather than merely present: the
// operator logout destination is the site's NAME PICKER, never `/login`.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The locale switcher (rendered inside the chrome) imports a server action whose
// module graph pulls in next-auth → `next/server`, which does not resolve under
// the vitest node resolver. Stub the action module and the router hook; neither
// participates in the markup this suite asserts.
vi.mock('@/i18n/actions', () => ({ setFloorLocaleAction: async () => undefined }));
// ADR-0078 G8c — `ConnectionState` (now inside the chrome) reads `usePathname`
// so the session-expired badge can return the operator to the screen they were
// on after signing in.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
  usePathname: () => '/operator/eugene/today',
}));

import { FloorChrome } from './floor-chrome';
import { LogOutButton } from './log-out-button';
import { resolveFloorNav } from './floor-nav';
import { I18nProvider } from '@/i18n/provider';
import { getDictionary } from '@/i18n/dictionary';
import type { Locale } from '@/i18n/config';

const SITE = 'eugene';

function renderAt(pathname: string, locale: Locale = 'en'): string {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <FloorChrome nav={resolveFloorNav(pathname)} />
    </I18nProvider>,
  );
}

describe('FloorChrome — Log Out presence', () => {
  it('renders Log Out on EVERY post-auth operator screen', () => {
    const postAuth = [
      `/operator/${SITE}/today`,
      `/operator/${SITE}/queue`,
      `/operator/${SITE}/inbound`,
      `/operator/${SITE}/count`,
      `/operator/${SITE}/processed`,
      `/operator/${SITE}/load/abc-123`,
    ];
    for (const path of postAuth) {
      expect(renderAt(path), path).toContain('Log Out');
    }
  });

  it('uses Bill\'s label "Log Out", not the old "Switch user"', () => {
    const html = renderAt(`/operator/${SITE}/today`);
    expect(html).toContain('Log Out');
    expect(html).not.toContain('Switch user');
  });

  it('does NOT offer Log Out on the pre-auth trio (no session to end)', () => {
    expect(renderAt('/operator')).not.toContain('Log Out');
    expect(renderAt(`/operator/${SITE}`)).not.toContain('Log Out');
    expect(renderAt(`/operator/${SITE}/some-user-id`)).not.toContain('Log Out');
  });
});

describe('FloorChrome — back', () => {
  it('gives the per-load dock workflow a back link to the hub', () => {
    expect(renderAt(`/operator/${SITE}/load/abc-123`)).toContain(`href="/operator/${SITE}/today"`);
  });

  it('renders no back pill on the hub or the site picker', () => {
    expect(renderAt(`/operator/${SITE}/today`)).not.toContain('href="/operator/eugene/today"');
    expect(renderAt('/operator')).not.toContain('<a ');
  });

  it('keeps >=44px touch targets (ADR-0060 gloved-hand sizing)', () => {
    expect(renderAt(`/operator/${SITE}/queue`)).toContain('min-h-[44px]');
  });

  it('mirrors the back chevron under RTL instead of hardcoding "left"', () => {
    expect(renderAt(`/operator/${SITE}/queue`, 'ur')).toContain('rtl:rotate-180');
  });

  it('carries the locale switcher on every screen, including pre-auth', () => {
    expect(renderAt('/operator')).toContain('aria-label="Language"');
    expect(renderAt(`/operator/${SITE}/today`)).toContain('aria-label="Language"');
  });
});

describe('LogOutButton — destination', () => {
  it('is a button, not a link to /login (operators have no SSO account)', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" dict={getDictionary('en')}>
        <LogOutButton siteCode={SITE} />
      </I18nProvider>,
    );
    // `/login` is a Microsoft Entra sign-in button a PIN operator can never
    // satisfy — landing there would strand them. The callbackUrl is the site
    // name picker; assert no /login ever appears in this control's markup.
    expect(html).not.toContain('/login');
    expect(html).toContain('<button');
  });

  it('renders the translated label in es and ur', () => {
    for (const [locale, expected] of [
      ['es', 'Cerrar sesión'],
      ['ur', 'لاگ آؤٹ'],
    ] as const) {
      const html = renderToStaticMarkup(
        <I18nProvider locale={locale} dict={getDictionary(locale)}>
          <LogOutButton siteCode={SITE} />
        </I18nProvider>,
      );
      expect(html, locale).toContain(expected);
      expect(html, locale).not.toContain('nav.log_out');
    }
  });
});
