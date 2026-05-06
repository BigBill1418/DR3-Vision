'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (pw.length < 12) {
      setError('Use at least 12 characters.');
      return;
    }
    if (pw !== pw2) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: pw }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Reset failed. The link may have expired.');
      setBusy(false);
      return;
    }
    setDone(true);
    setBusy(false);
    setTimeout(() => router.push('/login'), 1500);
  };

  if (!token) {
    return (
      <div className="flex w-full flex-col gap-4 text-white">
        <p className="text-red-400">This reset link is missing its token.</p>
        <Link
          href="/forgot-password"
          className="text-center text-sm text-white/70 underline-offset-4 hover:text-white hover:underline"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return <p className="text-white">Password updated. Redirecting to sign in…</p>;
  }

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <p className="text-center text-sm text-white/70">
        Choose a new password. At least 12 characters.
      </p>
      <label className="flex flex-col gap-1 text-sm font-medium text-white/80">
        New password
        <input
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-base text-white focus:border-dr3-green focus:outline-none focus:ring-1 focus:ring-dr3-green"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-white/80">
        Confirm
        <input
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-base text-white focus:border-dr3-green focus:outline-none focus:ring-1 focus:ring-dr3-green"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || pw === '' || pw2 === ''}
        className="mt-2 rounded-md bg-dr3-green px-4 py-2 text-base font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Set new password'}
      </button>
    </div>
  );
}
