'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/provider';
import { resolvePostLoginTarget } from '@/lib/routes';

// Single SSO button — Microsoft Entra ID (ADR-0016). Per CLAUDE.md
// hard rule #10 the surface uses an onClick handler instead of a
// native <form>; there's no other interactive element on the page
// besides the locale picker (a separate client component).
//
// Error param mapping (Auth.js v5 sets `?error=<code>` when redirecting
// here from a failed callback — see `pages.error` in auth.config.ts):
//
//   AccessDenied      signIn callback returned false (unauthorized email,
//                     inactive row, wrong role) → "you don't have access".
//   Configuration     Entra env vars missing/invalid → "SSO not
//                     configured yet" so an operator can finish the
//                     runbook in docs/operator/entra-id-setup.md.
//   Callback          OAuth callback failed AFTER a successful round
//                     trip — almost always a back-button replay through
//                     a consumed PKCE verifier → "Session expired".
//   anything else     generic "sign-in didn't complete" hint.

export function LoginForm() {
  const search = useSearchParams();
  const t = useT();
  // Default landing is the role-aware Vision Dashboard at `/` (HOME_ROUTE),
  // NOT the `/dashboard` site picker. A safe deep-link in `?next=` is honored;
  // external/unsafe values fall back to home. See src/lib/routes.ts.
  const next = resolvePostLoginTarget(search.get('next'));
  const errorParam = search.get('error');

  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    await signIn('microsoft-entra-id', { redirectTo: next });
    // signIn redirects to the IdP, so this only runs if the call
    // failed before the redirect (e.g. fetch error). Reset busy so
    // the user can retry.
    setBusy(false);
  };

  const errorMessage = (() => {
    if (!errorParam) return null;
    switch (errorParam) {
      case 'AccessDenied':
        return t('auth_login.error_access_denied');
      case 'Configuration':
        return t('auth_login.error_not_configured');
      case 'Callback':
        return t('auth_login.error_session_expired');
      default:
        return t('auth_login.error_generic');
    }
  })();

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      {errorMessage && (
        <p
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {errorMessage}
        </p>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="mt-2 inline-flex items-center justify-center gap-3 rounded-md bg-white px-4 py-3 text-base font-semibold text-black transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <MicrosoftLogo />
        {busy ? t('auth_login.redirecting') : t('auth_login.sign_in_with_microsoft')}
      </button>
      <p className="text-center text-xs text-white/60">{t('auth_login.sso_only_hint')}</p>
    </div>
  );
}

// Microsoft 4-tile logo. Inlined so we don't ship an extra asset
// just for the auth surface.
function MicrosoftLogo() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 21 21"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
