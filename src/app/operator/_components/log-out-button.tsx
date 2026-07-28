'use client';

// ADR-0065 — the operator "Log Out" control. RELOCATED from
// `operator/[site]/queue/sign-out-button.tsx`, where it lived in a leaf route
// directory and was cross-imported by `today/page.tsx` (`../queue/sign-out-button`)
// — a smell that only made sense while sign-out existed on 2 of the 9 operator
// screens. It now lives with the rest of the floor chrome and is mounted once,
// by FloorChrome, so every operator screen has it.
//
// TWO deliberate carry-overs from the original ADR-0004 control:
//
//  1. The DESTINATION stays the site's name picker (`/operator/<site>`), NOT
//     `/login`. Floor operators have no Entra/SSO account — they authenticate
//     with a 4-digit PIN from the name picker. Sending them to `/login` would
//     strand them on a Microsoft sign-in button they can never satisfy.
//  2. `signOut()` clears the JWT cookie, which is the whole point on a SHARED
//     device: the next operator must not inherit the previous one's session.
//
// What changed is the LABEL: "Switch user" → "Log Out" (Bill's explicit
// instruction — "switch user should be titled Log Out"). The behavior is still
// a shift handoff; the wording is what operators actually look for.

import { signOut } from 'next-auth/react';
import { useT } from '@/i18n/provider';
import { LogOutIcon, NavPillButton } from '@/app/_components/nav-pill';
import { GREEN_TONE } from './floor-tone';

export function LogOutButton({ siteCode }: { siteCode: string }) {
  const t = useT();
  return (
    <NavPillButton
      onClick={() => void signOut({ callbackUrl: `/operator/${siteCode}` })}
      label={t('nav.log_out')}
      ariaLabel={t('nav.log_out_aria')}
      toneClass={GREEN_TONE}
      icon={<LogOutIcon />}
    />
  );
}
