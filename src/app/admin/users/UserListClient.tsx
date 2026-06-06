'use client';

// ADR-0017 — admin Settings panel: client-side row actions.
//
// Each action button is a plain `<button onClick>` per CLAUDE.md
// hard rule #10. State refresh after a successful PATCH/DELETE
// is via `router.refresh()` so the server component re-runs its
// list query (URL-driven filters preserved).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { AdminUserDto } from '@/lib/admin-users';
import { adminMessages as M } from '@/app/admin/messages';

interface Props {
  users: AdminUserDto[];
}

export function UserListClient({ users }: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDeactivate = useCallback(
    async (id: string) => {
      if (!window.confirm(M.list.confirmDeactivate)) return;
      setPendingId(id);
      setError(null);
      try {
        const res = await fetch(`/api/admin/users/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deactivate' }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? M.errors.serverError);
          return;
        }
        router.refresh();
      } finally {
        setPendingId(null);
      }
    },
    [router],
  );

  const handleReactivate = useCallback(
    async (id: string) => {
      setPendingId(id);
      setError(null);
      try {
        const res = await fetch(`/api/admin/users/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reactivate' }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? M.errors.serverError);
          return;
        }
        router.refresh();
      } finally {
        setPendingId(null);
      }
    },
    [router],
  );

  if (users.length === 0) {
    return (
      <p
        className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-center text-dr3-mist-dim"
        data-testid="admin-users-empty"
      >
        {M.list.empty}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="admin-users-error"
        >
          {error}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-dr3-steel-light/25 bg-dr3-space-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-dr3-steel-light/25 text-left text-xs uppercase tracking-wider text-dr3-cyan">
              <th className="px-4 py-3">{M.list.columnName}</th>
              <th className="px-4 py-3">{M.list.columnEmail}</th>
              <th className="px-4 py-3">{M.list.columnRole}</th>
              <th className="px-4 py-3">{M.list.columnSite}</th>
              <th className="px-4 py-3">{M.list.columnStatus}</th>
              <th className="px-4 py-3">{M.list.columnLastLogin}</th>
              <th className="px-4 py-3">{M.list.columnActions}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className="border-b border-dr3-steel-light/15 text-dr3-mist last:border-b-0 odd:bg-dr3-space-2/40"
                data-testid={`admin-user-row-${u.id}`}
              >
                <td className="px-4 py-3 font-medium">{u.name}</td>
                <td className="px-4 py-3 text-dr3-mist-dim">{u.email ?? '—'}</td>
                <td className="px-4 py-3 capitalize">{u.role}</td>
                <td className="px-4 py-3">{u.primary_site_code ?? '—'}</td>
                <td className="px-4 py-3">
                  {u.is_active ? (
                    <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-200">
                      {M.list.statusActive}
                    </span>
                  ) : (
                    <span className="rounded-full bg-stone-900/40 px-2 py-0.5 text-xs text-stone-300">
                      {M.list.statusInactive}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-dr3-mist-dim">
                  {u.last_login_at ? formatDate(u.last_login_at) : M.list.neverSignedIn}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-2 py-1 text-xs text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan"
                      data-testid={`admin-user-edit-${u.id}`}
                    >
                      {M.list.edit}
                    </Link>
                    {u.is_active ? (
                      <button
                        type="button"
                        onClick={() => handleDeactivate(u.id)}
                        disabled={pendingId === u.id}
                        className="rounded-md bg-red-900/40 px-2 py-1 text-xs text-red-100 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`admin-user-deactivate-${u.id}`}
                      >
                        {M.list.deactivate}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleReactivate(u.id)}
                        disabled={pendingId === u.id}
                        className="rounded-md bg-emerald-900/40 px-2 py-1 text-xs text-emerald-100 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`admin-user-reactivate-${u.id}`}
                      >
                        {M.list.reactivate}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}
