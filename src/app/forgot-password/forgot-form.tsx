'use client';

import Link from 'next/link';
import { useState } from 'react';

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    // Always shows the same confirmation regardless of whether the
    // address is in the system, so the form can't be used as an
    // account-existence oracle. The API endpoint short-circuits on an
    // unknown address.
    await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }).catch(() => {});
    setSubmitted(true);
    setBusy(false);
  };

  if (submitted) {
    return (
      <div className="flex w-full flex-col gap-4 text-white">
        <p>
          If an account exists for <span className="font-semibold">{email}</span>, a reset link is
          on its way. The link expires in 15 minutes.
        </p>
        <Link
          href="/login"
          className="text-center text-sm text-white/70 underline-offset-4 hover:text-white hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <p className="text-center text-sm text-white/70">
        Enter your account email and we&apos;ll send a reset link.
      </p>
      <label className="flex flex-col gap-1 text-sm font-medium text-white/80">
        Email
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-base text-white placeholder:text-white/40 focus:border-dr3-green focus:outline-none focus:ring-1 focus:ring-dr3-green"
          placeholder="you@svdp.us"
        />
      </label>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || email === ''}
        className="mt-2 rounded-md bg-dr3-green px-4 py-2 text-base font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
      <Link
        href="/login"
        className="text-center text-sm text-white/60 underline-offset-4 hover:text-white hover:underline"
      >
        Back to sign in
      </Link>
    </div>
  );
}
