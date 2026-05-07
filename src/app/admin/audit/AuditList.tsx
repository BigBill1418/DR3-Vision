'use client';

// T-014 — audit log row list with expandable per-row diff.
//
// The collapsed state is the default; tapping the action chevron
// reveals the before/after table. Per CLAUDE.md hard rule #10 every
// expand toggle is a `<button onClick>`.

import Link from 'next/link';
import { useState } from 'react';
import type { AuditAction } from '@prisma/client';
import { adminMessages as M } from '@/app/admin/messages';
import { AuditDiff } from './AuditDiff';

export interface AuditListRow {
  id: string;
  created_at: string; // ISO string from server
  action: AuditAction;
  table_name: string;
  row_id: string;
  actor_user: { id: string; name: string; email: string | null; role: string } | null;
  actor_label: string | null;
  ip: string | null;
  user_agent: string | null;
  before: unknown;
  after: unknown;
  row_exists: boolean | null;
}

interface Props {
  rows: AuditListRow[];
}

const ACTION_LABEL: Record<AuditAction, string> = {
  insert: M.audit.actionInsert,
  update: M.audit.actionUpdate,
  delete: M.audit.actionDelete,
  soft_delete: M.audit.actionSoftDelete,
  restore: M.audit.actionRestore,
};

const ACTION_BADGE: Record<AuditAction, string> = {
  insert: 'bg-emerald-900/40 text-emerald-200',
  update: 'bg-sky-900/40 text-sky-200',
  delete: 'bg-red-900/40 text-red-200',
  soft_delete: 'bg-amber-900/40 text-amber-200',
  restore: 'bg-violet-900/40 text-violet-200',
};

export function AuditList({ rows }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (rows.length === 0) {
    return (
      <p
        className="rounded-md bg-dr3-green-dark/30 p-6 text-center text-dr3-cream/80"
        data-testid="admin-audit-empty"
      >
        {M.audit.empty}
      </p>
    );
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul className="flex flex-col divide-y divide-dr3-green-dark/40 overflow-hidden rounded-lg bg-dr3-green-dark/30">
      {rows.map((r) => {
        const isOpen = expanded.has(r.id);
        return (
          <li key={r.id} data-testid={`admin-audit-row-${r.id}`} className="px-4 py-3">
            <div className="grid grid-cols-12 items-center gap-3">
              <span className="col-span-12 text-xs font-medium tabular-nums text-dr3-cream sm:col-span-3">
                {formatTimestamp(r.created_at)}
              </span>
              <span className="col-span-6 truncate text-sm sm:col-span-3">
                <ActorCell
                  actor_user={r.actor_user}
                  actor_label={r.actor_label}
                />
              </span>
              <span className="col-span-3 sm:col-span-2">
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${ACTION_BADGE[r.action]}`}
                >
                  {ACTION_LABEL[r.action]}
                </span>
              </span>
              <span className="col-span-9 truncate text-xs text-dr3-cream/80 sm:col-span-3">
                <TargetCell
                  table_name={r.table_name}
                  row_id={r.row_id}
                  row_exists={r.row_exists}
                />
              </span>
              <span className="col-span-3 text-right sm:col-span-1">
                <button
                  type="button"
                  onClick={() => toggle(r.id)}
                  className="rounded-md bg-dr3-green-dark/60 px-2 py-1 text-xs text-dr3-cream hover:bg-dr3-green-dark/80"
                  aria-expanded={isOpen}
                  aria-controls={`audit-diff-${r.id}`}
                  data-testid={`admin-audit-toggle-${r.id}`}
                >
                  {isOpen ? M.audit.collapseDiff : M.audit.expandDiff}
                </button>
              </span>
            </div>
            {isOpen ? (
              <div
                id={`audit-diff-${r.id}`}
                className="mt-3"
                data-testid={`admin-audit-diff-${r.id}`}
              >
                <AuditDiff before={r.before} after={r.after} />
                {r.ip || r.user_agent ? (
                  <div className="mt-2 grid gap-1 text-[11px] text-dr3-cream/60 sm:grid-cols-2">
                    {r.ip ? (
                      <span>
                        IP: <span className="font-mono">{r.ip}</span>
                      </span>
                    ) : null}
                    {r.user_agent ? (
                      <span className="truncate">
                        UA: <span className="font-mono">{r.user_agent}</span>
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ──────────────────────────────────────────────────────────────────
// Cells
// ──────────────────────────────────────────────────────────────────

function ActorCell({
  actor_user,
  actor_label,
}: {
  actor_user: AuditListRow['actor_user'];
  actor_label: string | null;
}) {
  if (actor_user) {
    return (
      <span>
        <span className="font-medium text-dr3-cream">{actor_user.name}</span>
        <RoleBadge role={actor_user.role} />
        {actor_user.email ? (
          <span className="ml-2 text-dr3-cream/50">{actor_user.email}</span>
        ) : null}
      </span>
    );
  }
  if (actor_label) {
    return (
      <span className="font-mono text-dr3-cream/80">
        <span className="mr-1 rounded bg-dr3-ink/50 px-1.5 py-0.5 text-[10px] uppercase text-dr3-cream/70">
          {M.audit.systemActor}
        </span>
        {actor_label}
      </span>
    );
  }
  return <span className="text-dr3-cream/40">—</span>;
}

function RoleBadge({ role }: { role: string }) {
  const lower = role.toLowerCase();
  let label: string;
  if (lower === 'admin') label = M.audit.actorRoleAdmin;
  else if (lower === 'manager') label = M.audit.actorRoleManager;
  else if (lower === 'operator') label = M.audit.actorRoleOperator;
  else label = role;
  return (
    <span className="ml-2 rounded-full bg-dr3-ink/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-dr3-cream/70">
      {label}
    </span>
  );
}

function TargetCell({
  table_name,
  row_id,
  row_exists,
}: {
  table_name: string;
  row_id: string;
  row_exists: boolean | null;
}) {
  const href = buildTargetHref(table_name, row_id);

  // Linkable AND exists -> render the link.
  if (href && row_exists === true) {
    return (
      <Link
        href={href}
        className="font-mono text-dr3-cream/90 underline-offset-4 hover:text-dr3-cream hover:underline"
        data-testid="admin-audit-target-link"
      >
        <span className="text-dr3-cream/60">{table_name}/</span>
        {shortId(row_id)}
      </Link>
    );
  }

  // Linkable table, but the row was hard-deleted (rare; users use
  // soft-delete).
  if (href && row_exists === false) {
    return (
      <span className="font-mono text-dr3-cream/60" data-testid="admin-audit-target-deleted">
        <span className="text-dr3-cream/40">{table_name}/</span>
        {shortId(row_id)}
        <span className="ml-2 text-[10px] uppercase tracking-wider text-dr3-cream/50">
          {M.audit.rowDeleted}
        </span>
      </span>
    );
  }

  // Unlinkable table — render plain text.
  return (
    <span className="font-mono text-dr3-cream/60" data-testid="admin-audit-target-plain">
      <span className="text-dr3-cream/40">{table_name}/</span>
      {shortId(row_id)}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

export function buildTargetHref(table_name: string, row_id: string): string | null {
  if (table_name === 'users') return `/admin/users/${row_id}`;
  if (table_name === 'inbound_loads') {
    // The detail page is `/dashboard/[site]/load/[id]`. We don't store
    // site_id on the audit row (the audit log is table-agnostic), but
    // the detail page handler scopes by site so we can't link without
    // it. Strategy: defer to the loads list with a hash fragment that
    // the page can scroll-restore on. Cheap, accurate, no extra
    // round-trip.
    //
    // Future: T-011's per-load route accepts an arbitrary `?from_audit`
    // arg and looks up the site itself; but that's out of scope today.
    return `/admin/audit/load/${row_id}`;
  }
  return null;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
