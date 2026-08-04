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
  /**
   * ADR-0075 D4 — the row currently being merged AWAY, if any.
   *
   * The list itself is the picker: the admin opens "Merge into…" on the row that
   * should disappear and chooses the survivor from the same-site rows already on
   * screen. That keeps the tool inside the surface where the duplicates are
   * visible side by side, which is where the judgement actually gets made.
   */
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const merge = useCallback(
    async (winnerId: string, loserId: string) => {
      if (!window.confirm(M.equipment.mergeConfirm)) return;
      setPendingId(loserId);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch('/api/admin/equipment/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ winnerId, loserId }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          repointedLinks?: number;
          repointedRequests?: number;
        };
        if (!res.ok) {
          setError(body.error ?? M.errors.serverError);
          return;
        }
        setNotice(
          M.equipment.mergeSuccess((body.repointedLinks ?? 0) + (body.repointedRequests ?? 0)),
        );
        setMergingId(null);
        router.refresh();
      } finally {
        setPendingId(null);
      }
    },
    [router],
  );

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
      {notice ? (
        <p
          className="rounded-md bg-emerald-900/40 px-4 py-2 text-sm text-emerald-100"
          role="status"
          data-testid="admin-equipment-notice"
        >
          {notice}
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
                <td className="px-4 py-3 font-medium">
                  {e.display_name}
                  {/* ADR-0075 D5 — merged rows are filtered out of the default
                      list, so this only shows on the `includeMerged` view. It
                      exists so a row that IS reachable never reads as live. */}
                  {e.merged_into_id ? (
                    <span
                      className="ms-2 rounded-full bg-stone-900/60 px-2 py-0.5 text-xs text-stone-300"
                      data-testid={`admin-equipment-merged-${e.id}`}
                    >
                      {M.equipment.mergedBadge}
                    </span>
                  ) : null}
                </td>
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
                    {/* ADR-0075 D4 — merge this row AWAY into a survivor. Hidden
                        on rows that are themselves already merged. */}
                    {!e.merged_into_id ? (
                      <button
                        type="button"
                        onClick={() => setMergingId(mergingId === e.id ? null : e.id)}
                        className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-2 py-1 text-xs text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan"
                        data-testid={`admin-equipment-merge-${e.id}`}
                      >
                        {M.equipment.mergePickTarget}
                      </button>
                    ) : null}
                  </div>
                  {mergingId === e.id ? (
                    <MergePicker
                      loser={e}
                      candidates={equipment.filter(
                        (c) => c.id !== e.id && c.site_id === e.site_id && !c.merged_into_id,
                      )}
                      disabled={pendingId === e.id}
                      onCancel={() => setMergingId(null)}
                      onMerge={(winnerId) => void merge(winnerId, e.id)}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * ADR-0075 D4 — pick the SURVIVOR for a merge, from the same site only.
 *
 * The reference counts are shown on both sides because the direction matters and
 * is not obvious: the row carrying the invoices is usually the one that should
 * survive, and the admin cannot know that from the names alone. `link_count`
 * comes straight off the list DTO, so no extra request is needed to render it.
 *
 * Cross-site candidates are not offered at all — the API refuses them (hard rule
 * #2), and offering a choice the server will reject is a worse experience than
 * not offering it.
 */
function MergePicker({
  loser,
  candidates,
  disabled,
  onCancel,
  onMerge,
}: {
  loser: AdminEquipmentDto;
  candidates: AdminEquipmentDto[];
  disabled: boolean;
  onCancel: () => void;
  onMerge: (winnerId: string) => void;
}) {
  const [winnerId, setWinnerId] = useState('');

  return (
    <section
      className="mt-2 flex flex-col gap-2 rounded-md border border-dr3-steel-light/25 bg-dr3-space/60 p-3"
      data-testid={`admin-equipment-merge-panel-${loser.id}`}
    >
      <p className="text-xs text-dr3-mist-dim">
        <b className="text-dr3-mist">{M.equipment.mergeLoser}:</b> {loser.display_name} ·{' '}
        {M.equipment.mergeReferences(loser.link_count, loser.resolved_request_count)}
      </p>
      {candidates.length === 0 ? (
        <p className="text-xs text-dr3-mist-dim">{M.equipment.empty}</p>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-dr3-mist">
          {M.equipment.mergeWinner}
          <select
            value={winnerId}
            onChange={(ev) => setWinnerId(ev.target.value)}
            className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-2 py-1 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
            data-testid={`admin-equipment-merge-winner-${loser.id}`}
          >
            <option value="" className="text-dr3-space">
              —
            </option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id} className="text-dr3-space">
                {c.display_name} (
                {M.equipment.mergeReferences(c.link_count, c.resolved_request_count)})
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onMerge(winnerId)}
          disabled={disabled || !winnerId}
          className="rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-dr3-space disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`admin-equipment-merge-submit-${loser.id}`}
        >
          {M.equipment.mergeSubmit}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          {M.equipment.mergeCancel}
        </button>
      </div>
    </section>
  );
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}
