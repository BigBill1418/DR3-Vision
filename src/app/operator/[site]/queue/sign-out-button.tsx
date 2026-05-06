'use client';

import { signOut } from 'next-auth/react';
import { useT } from '@/i18n/provider';

// "Switch user" per ADR-0004 — explicit operator handoff between
// shifts. signOut clears the JWT cookie and routes back to the
// site name picker.
export function SignOutButton({ siteCode }: { siteCode: string }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => void signOut({ callbackUrl: `/operator/${siteCode}` })}
      className="self-start rounded-md bg-dr3-green px-4 py-2 text-base font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark"
    >
      {t('queue.switch_user')}
    </button>
  );
}
