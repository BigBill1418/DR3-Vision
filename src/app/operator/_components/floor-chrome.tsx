'use client';

// ADR-0065 — operator (iPad) app chrome: back + Log Out + language, on EVERY
// operator screen, mounted once in the operator route-group layout.
//
// Before this, back was per-page and inconsistent (three incompatible header
// shapes) and sign-out existed on only 2 of the 9 operator screens. The worst
// case was `/operator/<site>/load/<id>` — a 7-stage workflow whose ONLY exits
// were submit and reject. An operator who opened the wrong load had no way out.
//
// It is a SEPARATE component from ManagerChrome on purpose. The two surfaces
// have genuinely different auth models (PIN + shared device + name-picker exit
// vs Entra SSO + personal device + /login exit) and genuinely different palettes
// (hard rule #3 / ADR-0008: the floor stays on high-contrast green because
// operators work outdoors). Only the pill SHAPE is shared, via `NavPill`.
//
// The band also HOSTS the locale switcher. That switcher used to be
// `fixed end-3 top-3`, floating over whatever the page rendered — which is why
// it collided with the logo on the site picker and the sign-out button on the
// queue. Bringing it into the chrome row removes the overlap class entirely
// rather than papering over it with per-page top padding.

import { ConnectionState } from './connection-state';
import { FloorLocaleSwitcher } from './floor-locale-switcher';
import { LogOutButton } from './log-out-button';
import { ChevronBackIcon, NavPillLink } from '@/app/_components/nav-pill';
import { GREEN_TONE } from './floor-tone';
import { useT } from '@/i18n/provider';
import type { FloorNav } from './floor-nav';

export function FloorChrome({ nav }: { nav: FloorNav }) {
  const t = useT();
  return (
    <nav
      aria-label={t('nav.floor_chrome_aria')}
      // Sticky (not fixed) so the band participates in layout and the page
      // below never needs a magic top-padding number to clear it.
      className="sticky top-0 z-40 border-b border-white/10 bg-black/60 backdrop-blur-sm"
    >
      <div className="mx-auto flex min-h-[60px] max-w-3xl items-center justify-between gap-2 px-4 py-2">
        <div className="flex items-center gap-2">
          {nav.backHref && (
            <NavPillLink
              href={nav.backHref}
              label={t('nav.back')}
              ariaLabel={t('nav.back_aria')}
              toneClass={GREEN_TONE}
              icon={<ChevronBackIcon />}
            />
          )}
          {nav.showLogOut && nav.siteCode && <LogOutButton siteCode={nav.siteCode} />}
        </div>
        <div className="flex items-center gap-2">
          {/* ADR-0078 D9 — connection state, on every screen, mounted once.
              Only on post-auth surfaces: the pre-PIN trio has no queued work and
              no session, so an indicator there would report on nothing. */}
          {!nav.isAuthSurface && <ConnectionState siteCode={nav.siteCode} />}
          <FloorLocaleSwitcher />
        </div>
      </div>
    </nav>
  );
}
