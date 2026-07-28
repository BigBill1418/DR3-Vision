'use client';

// ADR-0063 — admin equipment master: client-side row actions.
//
// Mirrors `UserListClient` (ADR-0017): every action is a plain
// `<button onClick>` (CLAUDE.md hard rule #10), and a successful PATCH ends in
// `router.refresh()` so the server component re-runs its query with the URL's
// filters intact — the row action never navigates, so the view survives.
//
// Deactivate is the ONLY removal offered. There is no delete button because
// there is no delete endpoint (see the `[id]` route header).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { AdminEquipmentDto } from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { CATEGORY_LABEL } from './labels';

interface Props {
  equipment: AdminEquipmentDto[];
  /**
   * The list's current filters as a bare query string, appended to the Edit
   * link so the edit page can hand the admin back to this same view.
   */
  listQuery?: string;
}

export function EquipmentListClient({ equipment, listQuery = '' }: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setActive = useCallback(
    async (id: string, action: 'deactivate' | 'reactivate') => {
      if (action === 'deactivate' && !window.confirm(M.equipment.confirmDeactivate)) return;
      setPendingId(id);
      setError(null);
      try {
        const res = await fetch(`/api/admin/equipment/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
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

  if (equipment.length === 0) {
    return (
      <p
        className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-center text-dr3-mist-dim"
        data-testid="admin-equipment-empty"
      >
        {M.equipment.empty}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="admin-equipment-error"
        >
          {error}
        </p>
      ) : null}
      <p className="text-xs text-dr3-mist-dim" data-testid="admin-equipment-count">
        {M.equipment.resultCount(equipment.length)}
      </p>
      <div className="overflow-x-auto rounded-md border border-dr3-steel-light/25 bg-dr3-space-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-dr3-steel-light/25 text-left text-xs uppercase tracking-wider text-dr3-cyan">
              <th className="px-4 py-3">{M.equipment.columnName}</th>
              <th className="px-4 py-3">{M.equipment.columnCategory}</th>
              <th className="px-4 py-3">{M.equipment.columnSite}</th>
              <th className="px-4 py-3">{M.equipment.columnStatus}</th>
              <th className="px-4 py-3">{M.equipment.columnLinks}</th>
              <th className="px-4 py-3">{M.equipment.columnUpdated}</th>
              <th className="px-4 py-3">{M.equipment.columnActions}</th>
            </tr>
          </thead>
          <tbody>
            {equipment.map((e) => (
              <tr
                key={e.id}
                className="border-b border-dr3-steel-light/15 text-dr3-mist last:border-b-0 odd:bg-dr3-space-2/40"
                data-testid={`admin-equipment-row-${e.id}`}
              >
                <td className="px-4 py-3 font-medium">{e.display_name}</td>
                <td className="px-4 py-3 text-dr3-mist-dim">{CATEGORY_LABEL[e.category]}</td>
                <td className="px-4 py-3">{e.site_code ?? '—'}</td>
                <td className="px-4 py-3">
                  {e.is_active ? (
                    <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-200">
                      {M.equipment.statusActive}
                    </span>
                  ) : (
                    <span className="rounded-full bg-stone-900/40 px-2 py-0.5 text-xs text-stone-300">
                      {M.equipment.statusInactive}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-dr3-mist-dim">{e.link_count || '—'}</td>
                <td className="px-4 py-3 text-dr3-mist-dim">{formatDate(e.updated_at)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={
                        listQuery
                          ? `/admin/equipment/${e.id}?${listQuery}`
                          : `/admin/equipment/${e.id}`
                      }
                      className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-2 py-1 text-xs text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan"
                      data-testid={`admin-equipment-edit-${e.id}`}
                    >
                      {M.equipment.edit}
                    </Link>
                    {e.is_active ? (
                      <button
                        type="button"
                        onClick={() => setActive(e.id, 'deactivate')}
                        disabled={pendingId === e.id}
                        className="rounded-md bg-red-900/40 px-2 py-1 text-xs text-red-100 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`admin-equipment-deactivate-${e.id}`}
                      >
                        {M.equipment.deactivate}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setActive(e.id, 'reactivate')}
                        disabled={pendingId === e.id}
                        className="rounded-md bg-emerald-900/40 px-2 py-1 text-xs text-emerald-100 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`admin-equipment-reactivate-${e.id}`}
                      >
                        {M.equipment.reactivate}
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
