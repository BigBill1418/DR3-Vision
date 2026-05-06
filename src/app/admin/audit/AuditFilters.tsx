'use client';

// T-014 — filter bar for /admin/audit.
//
// Per CLAUDE.md hard rule #10 the "apply" trigger is a `<button>` with
// `onClick`, NOT a `<form onSubmit>`. The component holds the working
// filter state locally; on Apply it pushes the new URL via
// `router.push`. The server component re-runs and reflects the new
// state on next render. URL is the source of truth (shareable,
// back-button friendly) — local state only exists between user input
// and Apply.

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { AuditAction } from '@prisma/client';
import { adminMessages as M } from '@/app/admin/messages';
import { AUDIT_ACTIONS } from '@/lib/admin-audit';
import { buildAuditQueryString } from '@/lib/admin-audit-url';

export interface AuditFilterDraft {
  actor: string | null;
  table: string | null;
  from: string | null;
  to: string | null;
  actions: AuditAction[];
}

interface ActorOption {
  id: string;
  label: string;
}

interface TableOption {
  value: string;
  label: string;
}

interface Props {
  initial: AuditFilterDraft;
  actors: ActorOption[];
  tables: TableOption[];
}

const ACTION_LABELS: Record<AuditAction, string> = {
  insert: M.audit.actionInsert,
  update: M.audit.actionUpdate,
  delete: M.audit.actionDelete,
  soft_delete: M.audit.actionSoftDelete,
  restore: M.audit.actionRestore,
};

export function AuditFilters({ initial, actors, tables }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState<AuditFilterDraft>(initial);

  const toggleAction = (a: AuditAction) => {
    setDraft((prev) => {
      const set = new Set(prev.actions);
      if (set.has(a)) set.delete(a);
      else set.add(a);
      // Preserve canonical enum order so the URL is stable.
      const ordered = AUDIT_ACTIONS.filter((x) => set.has(x));
      return { ...prev, actions: ordered };
    });
  };

  const apply = () => {
    const qs = buildAuditQueryString({
      actor: draft.actor,
      table: draft.table,
      from: draft.from,
      to: draft.to,
      actions: draft.actions,
      page: 1,
    });
    startTransition(() => {
      router.push(qs ? `/admin/audit?${qs}` : '/admin/audit');
    });
  };

  const reset = () => {
    setDraft({ actor: null, table: null, from: null, to: null, actions: [] });
    startTransition(() => {
      router.push('/admin/audit');
    });
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-lg bg-dr3-green-dark/30 p-4"
      aria-busy={isPending}
      data-testid="admin-audit-filters"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-dr3-cream/60">
        {M.audit.filtersHeading}
      </h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <FieldLabel text={M.audit.filterActor}>
          <select
            value={draft.actor ?? ''}
            disabled={isPending}
            onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value || null }))}
            className="rounded-md bg-dr3-green-dark/60 px-2 py-2 text-sm text-dr3-cream disabled:opacity-60"
            data-testid="admin-audit-filter-actor"
          >
            <option value="">{M.audit.filterAllActors}</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </FieldLabel>

        <FieldLabel text={M.audit.filterTable}>
          <select
            value={draft.table ?? ''}
            disabled={isPending}
            onChange={(e) => setDraft((d) => ({ ...d, table: e.target.value || null }))}
            className="rounded-md bg-dr3-green-dark/60 px-2 py-2 text-sm text-dr3-cream disabled:opacity-60"
            data-testid="admin-audit-filter-table"
          >
            <option value="">{M.audit.filterAllTables}</option>
            {tables.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </FieldLabel>

        <FieldLabel text={M.audit.filterFrom}>
          <input
            type="date"
            value={draft.from ?? ''}
            disabled={isPending}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || null }))}
            className="rounded-md bg-dr3-green-dark/60 px-2 py-2 text-sm text-dr3-cream disabled:opacity-60"
            data-testid="admin-audit-filter-from"
          />
        </FieldLabel>

        <FieldLabel text={M.audit.filterTo}>
          <input
            type="date"
            value={draft.to ?? ''}
            disabled={isPending}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || null }))}
            className="rounded-md bg-dr3-green-dark/60 px-2 py-2 text-sm text-dr3-cream disabled:opacity-60"
            data-testid="admin-audit-filter-to"
          />
        </FieldLabel>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cream/60">
          {M.audit.filterActions}
        </span>
        <div className="flex flex-wrap gap-2">
          {AUDIT_ACTIONS.map((a) => {
            const active = draft.actions.includes(a);
            return (
              <button
                key={a}
                type="button"
                onClick={() => toggleAction(a)}
                disabled={isPending}
                aria-pressed={active}
                data-testid={`admin-audit-filter-action-${a}`}
                className={
                  active
                    ? 'rounded-full bg-dr3-chartreuse px-3 py-1 text-xs font-semibold text-dr3-ink disabled:opacity-60'
                    : 'rounded-full bg-dr3-green-dark/60 px-3 py-1 text-xs font-medium text-dr3-cream/80 hover:bg-dr3-green-dark/80 disabled:opacity-60'
                }
              >
                {ACTION_LABELS[a]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={isPending}
          className="rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink transition-colors hover:bg-dr3-chartreuse/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-audit-apply"
        >
          {M.audit.filterApply}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={isPending}
          className="rounded-md bg-dr3-green-dark/60 px-4 py-2 text-sm font-medium text-dr3-cream transition-colors hover:bg-dr3-green-dark/80 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-audit-reset"
        >
          {M.audit.filterReset}
        </button>
      </div>
    </section>
  );
}

function FieldLabel({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cream/60">
        {text}
      </span>
      {children}
    </label>
  );
}
