'use client';

import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';

// Per CLAUDE.md hard rule #10 the form uses onClick handlers, not a
// native <form>. Submit fires from the button; Enter-key still works
// because each input has its own onKeyDown handler.
export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get('next') ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });
    if (res?.error) {
      setError('Invalid email or password.');
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <label className="flex flex-col gap-1 text-sm font-medium text-white/80">
        Email
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={onEnter}
          className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-base text-white placeholder:text-white/40 focus:border-dr3-green focus:outline-none focus:ring-1 focus:ring-dr3-green"
          placeholder="you@svdp.us"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-white/80">
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={onEnter}
          className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-base text-white placeholder:text-white/40 focus:border-dr3-green focus:outline-none focus:ring-1 focus:ring-dr3-green"
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
        disabled={busy || email === '' || password === ''}
        className="mt-2 rounded-md bg-dr3-green px-4 py-2 text-base font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <Link
        href="/forgot-password"
        className="text-center text-sm text-white/60 underline-offset-4 hover:text-white hover:underline"
      >
        Forgot your password?
      </Link>
    </div>
  );
}
