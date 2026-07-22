'use client';

// ADR-0057 D4 — reconciliation queue client. Per-item Approve/Reject/Snooze with a
// REQUIRED note (client guard; the server re-validates), plus filter + bulk-approve
// by class. CLAUDE.md hard rule #10 — no <form>, no submit handler; everything
// posts via onClick.

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface ReconItem {
  id: string;
  mirrorTable: string;
  mirrorRecordId: string;
  targetTable: string;
  targetRecordId: string | null;
  fieldName: string;
  changeKind: string;
  status: string;
  mymrcValue: unknown;
  visionValue: unknown;
  createdAt: string;
  snoozeUntil: string | null;
}

type Decision = 'approved' | 'rejected' | 'snoozed';

const CHANGE_KINDS = ['new_record', 'field_update', 'disappeared'] as const;

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function ReconcileClient({ initialItems }: { initialItems: ReconItem[] }) {
  const router = useRouter();
  const [mirrorFilter, setMirrorFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      initialItems.filter(
        (i) =>
          (!mirrorFilter || i.mirrorTable === mirrorFilter) &&
          (!kindFilter || i.changeKind === kindFilter),
      ),
    [initialItems, mirrorFilter, kindFilter],
  );
  const mirrorTables = useMemo(
    () => [...new Set(initialItems.map((i) => i.mirrorTable))].sort(),
    [initialItems],
  );

  const decide = useCallback(
    async (item: ReconItem, decision: Decision, note: string) => {
      if (!note.trim()) {
        setMsg('A note is required — describe the decision, then act.');
        return;
      }
      setBusyId(item.id);
      setMsg(null);
      try {
        const res = await fetch(`/api/admin/mymrc/reconcile/${item.id}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, note: note.trim() }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 409) {
          setMsg('This item was already decided. Refreshing.');
        } else if (!res.ok) {
          setMsg(body.error ?? `decision failed (${res.status})`);
          return;
        }
        router.refresh();
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const bulkApprove = useCallback(
    async (note: string) => {
      if (!mirrorFilter || !kindFilter) {
        setMsg('Pick a mirror table AND a change kind to bulk-approve a class.');
        return;
      }
      if (!note.trim()) {
        setMsg('A note is required for a bulk approval.');
        return;
      }
      setBusyId('__bulk__');
      setMsg(null);
      try {
        const res = await fetch('/api/admin/mymrc/reconcile/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mirror_table: mirrorFilter,
            change_kind: kindFilter,
            note: note.trim(),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          approved?: string[];
          failed?: unknown[];
          error?: string;
        };
        if (!res.ok) {
          setMsg(body.error ?? `bulk approve failed (${res.status})`);
          return;
        }
        setMsg(
          `Approved ${body.approved?.length ?? 0}; ${body.failed?.length ?? 0} failed.`,
        );
        router.refresh();
      } finally {
        setBusyId(null);
      }
    },
    [router, mirrorFilter, kindFilter],
  );

  return (
    <section className="flex flex-col gap-5" data-testid="reconcile">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-dr3-mist-dim">Mirror table</span>
          <select
            value={mirrorFilter}
            onChange={(e) => setMirrorFilter(e.target.value)}
            className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist"
            data-testid="filter-mirror"
          >
            <option value="">All</option>
            {mirrorTables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-dr3-mist-dim">Change kind</span>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist"
            data-testid="filter-kind"
          >
            <option value="">All</option>
            {CHANGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>

      {msg ? (
        <p
          className="rounded-md bg-dr3-space-2/70 px-4 py-2 text-sm text-dr3-mist"
          role="status"
          data-testid="reconcile-msg"
        >
          {msg}
        </p>
      ) : null}

      {mirrorFilter && kindFilter ? (
        <BulkBar
          count={shown.length}
          disabled={busyId !== null}
          onApprove={bulkApprove}
          className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/40 p-3"
        />
      ) : null}

      {shown.length === 0 ? (
        <p className="text-sm text-dr3-mist-dim" data-testid="reconcile-empty">
          Nothing pending. The queue is clear.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((item) => (
            <ReconRow key={item.id} item={item} busy={busyId === item.id} onDecide={decide} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BulkBar({
  count,
  disabled,
  onApprove,
  className,
}: {
  count: number;
  disabled: boolean;
  onApprove: (note: string) => void;
  className?: string;
}) {
  const [note, setNote] = useState('');
  return (
    <div className={`flex flex-wrap items-end gap-3 ${className ?? ''}`} data-testid="bulk-bar">
      <label className="flex flex-1 flex-col gap-1 text-sm">
        <span className="text-dr3-mist-dim">Bulk-approve note (applies to all {count})</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist"
          data-testid="bulk-note"
        />
      </label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onApprove(note)}
        className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="bulk-approve"
      >
        Approve all {count}
      </button>
    </div>
  );
}

function ReconRow({
  item,
  busy,
  onDecide,
}: {
  item: ReconItem;
  busy: boolean;
  onDecide: (item: ReconItem, decision: Decision, note: string) => void;
}) {
  const [note, setNote] = useState('');
  const act = (d: Decision) => onDecide(item, d, note);
  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/50 p-4"
      data-testid="reconcile-row"
      data-id={item.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-dr3-steel/40 px-2 py-0.5 font-semibold uppercase tracking-wide">
          {item.changeKind}
        </span>
        <span className="text-dr3-mist-dim">
          {item.mirrorTable} → {item.targetTable}
          {item.fieldName ? ` · ${item.fieldName}` : ''}
        </span>
        {item.status === 'snoozed' ? (
          <span className="rounded bg-amber-900/50 px-2 py-0.5 text-amber-100">snoozed</span>
        ) : null}
      </div>
      <div className="grid gap-1 text-sm sm:grid-cols-2">
        <div>
          <span className="text-dr3-mist-dim">MyMRC: </span>
          <span className="font-medium">{fmtValue(item.mymrcValue)}</span>
        </div>
        <div>
          <span className="text-dr3-mist-dim">Vision: </span>
          <span className="font-medium">{fmtValue(item.visionValue)}</span>
        </div>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-dr3-mist-dim">Note (required)</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist"
          data-testid="row-note"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => act('approved')}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          data-testid="row-approve"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act('rejected')}
          className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
          data-testid="row-reject"
        >
          Reject
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act('snoozed')}
          className="rounded-md bg-dr3-steel/60 px-3 py-1.5 text-sm font-semibold text-dr3-mist hover:bg-dr3-steel disabled:opacity-50"
          data-testid="row-snooze"
        >
          Snooze 7d
        </button>
      </div>
    </li>
  );
}
