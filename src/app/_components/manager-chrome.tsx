'use client';

// ADR-0065 — manager app chrome: back + LOG OUT on every manager screen.
//
// Supersedes the ADR-0064 back-only bar (`back-to-dashboard.tsx`, removed). That
// bar gave the 56 manager pages (dashboard / bonus / admin) an in-app path back
// to `/`, but there was still NO sign-out control anywhere on the manager
// surface — a manager's only way out was clearing cookies. This adds it, in the
// same one-edit-per-group-layout way, so no page files change.
//
// Design contract (inherited + extended):
//   - back is a real <Link href="/"> to the Vision Dashboard (HOME_ROUTE), NEVER
//     router.back(). Deterministic, SSR-safe, and unaffected by history depth.
//   - ≥44px touch targets + persistent bordered pills + visible focus ring
//     (shared `NavPill` primitive, `space` tone).
//   - on `/` itself there is nothing above, so `showBack={false}` renders the
//     sign-out alone rather than a link to the page you are already on.
//
// LOGOUT SEMANTICS — local sign-out only. `signOut()` clears the Auth.js session
// cookie and lands on `/login?signedout=1` (which shows a confirmation). It does
// NOT perform an Entra front-channel logout, so the user's M365 session in the
// same browser is deliberately left alone: managers live in Outlook/Teams all
// day and signing them out of Microsoft because they left Vision would be
// hostile. Bill chose this explicitly. Consequence: "sign out then sign in" is a
// silent SSO round-trip, not a password prompt — this is NOT a shared-device
// logout. The shared device is the iPad, and it has its own chrome (FloorChrome)
// with a PIN-based identity model.
//
// Two exports, mirroring the ADR-0064 shape:
//   - ManagerChromeBar — presentational, explicit labels. Used by /admin, which
//     deliberately mounts no I18nProvider (ADR-0017, English-only).
//   - ManagerChromeNav — resolves EN/ES/UR via `useT()` (hard rule #4). Used by
//     the dashboard + bonus layouts, which mount the manager dictionary.

import { signOut } from 'next-auth/react';
import { HOME_ROUTE } from '@/lib/routes';
import { useT } from '@/i18n/provider';
import { ChevronBackIcon, LogOutIcon, NavPillButton, NavPillLink, SPACE_TONE } from './nav-pill';

/** Where a signed-out manager lands. The flag drives the /login confirmation. */
export const SIGNED_OUT_ROUTE = '/login?signedout=1';

export function ManagerChromeBar({
  backLabel,
  backAriaLabel,
  signOutLabel,
  signOutAriaLabel,
  showBack = true,
}: {
  backLabel: string;
  backAriaLabel: string;
  signOutLabel: string;
  signOutAriaLabel: string;
  showBack?: boolean;
}) {
  return (
    <nav
      aria-label={backAriaLabel}
      className="sticky top-0 z-40 border-b border-dr3-steel-light/20 bg-dr3-space/90 backdrop-blur supports-[backdrop-filter]:bg-dr3-space/75"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-2 sm:px-10">
        {showBack ? (
          <NavPillLink
            href={HOME_ROUTE}
            label={backLabel}
            ariaLabel={backAriaLabel}
            toneClass={SPACE_TONE}
            icon={<ChevronBackIcon />}
          />
        ) : (
          <span />
        )}
        <NavPillButton
          onClick={() => void signOut({ callbackUrl: SIGNED_OUT_ROUTE })}
          label={signOutLabel}
          ariaLabel={signOutAriaLabel}
          toneClass={SPACE_TONE}
          icon={<LogOutIcon />}
        />
      </div>
    </nav>
  );
}

export function ManagerChromeNav({ showBack = true }: { showBack?: boolean }) {
  const t = useT();
  return (
    <ManagerChromeBar
      backLabel={t('nav.back_to_dashboard')}
      backAriaLabel={t('nav.back_to_dashboard_aria')}
      signOutLabel={t('nav.sign_out')}
      signOutAriaLabel={t('nav.sign_out_aria')}
      showBack={showBack}
    />
  );
}
