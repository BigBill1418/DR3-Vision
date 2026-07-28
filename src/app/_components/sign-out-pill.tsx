'use client';

// ADR-0065 — a standalone sign-out pill for surfaces that need the control
// WITHOUT the full chrome bar. Today that is exactly one surface: `/`, the
// Vision Dashboard, which has no route-group layout and therefore inherits no
// ManagerChrome, and which needs no back pill because it IS the back
// destination.
//
// Same local-sign-out semantics as ManagerChrome (see that file): the Auth.js
// session cookie is cleared and the user lands on `/login?signedout=1`; the
// Entra/M365 session in the same browser is deliberately untouched.

import { signOut } from 'next-auth/react';
import { LogOutIcon, NavPillButton, SPACE_TONE } from './nav-pill';
import { SIGNED_OUT_ROUTE } from './manager-chrome';

export function SignOutPill({ label, ariaLabel }: { label: string; ariaLabel: string }) {
  return (
    <NavPillButton
      onClick={() => void signOut({ callbackUrl: SIGNED_OUT_ROUTE })}
      label={label}
      ariaLabel={ariaLabel}
      toneClass={SPACE_TONE}
      icon={<LogOutIcon />}
    />
  );
}
