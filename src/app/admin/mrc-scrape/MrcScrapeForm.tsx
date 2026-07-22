'use client';

// ADR-0057 — MyMRC admin-credential entry form.
//
// CLAUDE.md hard rule #10 — no `<form>` element, no submit handler; everything
// posts via `onClick`.
//
// Write-only password: the server sends only NON-SECRET status (never the
// password). When a credential is already configured, the password field renders
// blank with a "•••••••• (set)" placeholder and a note that it is never
// pre-filled. Saving always requires the password (the store re-encrypts on every
// write — there is no partial username-only update), matching the write-only PIN
// pattern in UserCreateForm.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminMessages as M } from '@/app/admin/messages';

interface Props {
  configured: boolean;
  username: string | null;
  /** ISO-8601 timestamp, or null when unconfigured. */
  updatedAt: string | null;
  updatedBy: string | null;
  /** Fired after a successful save so a sibling (e.g. the status panel) can refetch. */
  onSaved?: () => void;
}

export function MrcScrapeForm({
  configured,
  username: initialUsername,
  updatedAt,
  updatedBy,
  onSaved,
}: Props) {
  const router = useRouter();
  const [username, setUsername] = useState(initialUsername ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    setNotice(null);

    if (!username.trim()) {
      setError(M.mrc.usernameRequired);
      return;
    }
    if (!password.trim()) {
      setError(M.mrc.passwordRequired);
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/admin/mrc-scrape/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.errors.serverError);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { warning?: string };
      // Clear the password from memory/UI immediately after a successful save.
      setPassword('');
      setNotice(body.warning ? `${M.mrc.saved} ${body.warning}` : M.mrc.saved);
      router.refresh();
      onSaved?.();
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-5">
      <div
        className="flex flex-col gap-1 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/60 px-4 py-3 text-sm"
        data-testid="mrc-status"
        data-configured={configured ? 'true' : 'false'}
      >
        <span className="font-medium text-dr3-mist">
          {configured ? M.mrc.statusConfigured : M.mrc.statusNotConfigured}
        </span>
        {configured ? (
          <span className="text-xs text-dr3-mist-dim">
            {updatedAt ? `${M.mrc.lastUpdated}: ${new Date(updatedAt).toLocaleString()}` : null}
            {updatedBy ? ` · ${M.mrc.updatedBy}: ${updatedBy}` : null}
          </span>
        ) : null}
      </div>

      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="mrc-error"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          className="rounded-md bg-emerald-900/40 px-4 py-2 text-sm text-emerald-100"
          role="status"
          data-testid="mrc-notice"
        >
          {notice}
        </p>
      ) : null}

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-dr3-mist">{M.mrc.usernameLabel}</span>
        <input
          type="text"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="mrc-username"
        />
        <span className="text-xs text-dr3-mist-dim">{M.mrc.usernameHelp}</span>
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-dr3-mist">{M.mrc.passwordLabel}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={configured ? M.mrc.passwordSetPlaceholder : ''}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="mrc-password"
        />
        <span className="text-xs text-dr3-mist-dim">
          {configured ? M.mrc.passwordHelpSet : M.mrc.passwordHelpUnset}
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="mrc-submit"
        >
          {pending ? M.mrc.saving : M.mrc.save}
        </button>
      </div>
    </section>
  );
}
