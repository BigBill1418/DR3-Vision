'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/provider';

// Single SSO button — Microsoft Entra ID (ADR-0016). Per CLAUDE.md
// hard rule #10 the surface uses an onClick handler instead of a
// native <form>; there's no other interactive element on the page
// besides the locale picker (a separate client component).
//
// `error=AccessDenied` is what NextAuth sets in the URL when the
// `signIn` callback returned false — we surface a non-revealing
// "you don't have access" message rather than blaming the IdP.
//
// `error=Configuration` is set when the Entra env vars are missing
// or invalid — we surface a distinct "SSO is not configured yet"
// hint so an operator can ask Bill to finish the runbook in
// `docs/operator/entra-id-setup.md`.

export function LoginForm() {
  const search = useSearchParams();
  const t = useT();
  const next = search.get('next') ?? '/dashboard';
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

  const errorMessage =
    errorParam === 'AccessDenied'
      ? t('auth_login.error_access_denied')
      : errorParam === 'Configuration'
        ? t('auth_login.error_not_configured')
        : errorParam
          ? t('auth_login.error_generic')
          : null;

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
