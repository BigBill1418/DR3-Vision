'use client';

// ADR-0019 §9 — Bonus employee management client surface.
//
// Add / rename / deactivate / reactivate, all via fetch() to the gated
// /api/bonus/employees endpoints + router.refresh() on success (CLAUDE.md hard
// rule #10 — no <form>, no server actions). The server page owns the gate and
// the initial list; this component re-fetches the page after each mutation.
//
// §9a rehire flow: a create that collides with a deactivated record returns
// { rehire_candidate: true, employee } (HTTP 409). We surface a confirm prompt
// — default = reactivate — instead of an error.

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface EmployeeRow {
  id: string;
  full_name: string;
  previous_names: { name: string; changed_at: string }[];
  is_active: boolean;
  deleted_at: string | null;
}

interface Props {
  employees: EmployeeRow[];
}

interface RehirePrompt {
  id: string;
  name: string;
  deactivatedAt: string | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown date' : d.toLocaleDateString();
}

export function EmployeeManager({ employees }: Props) {
  const router = useRouter();
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [rehire, setRehire] = useState<RehirePrompt | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const refresh = () => router.refresh();

  const handleAdd = async () => {
    setError(null);
    const name = newName.trim();
    if (!name) {
      setError('Enter an employee name.');
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/bonus/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: name }),
      });
      if (res.status === 201) {
        setNewName('');
        refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        rehire_candidate?: boolean;
        employee?: { id: string; full_name: string; deleted_at: string | null };
        error?: string;
      };
      if (res.status === 409 && body.rehire_candidate && body.employee) {
        setRehire({
          id: body.employee.id,
          name: body.employee.full_name,
          deactivatedAt: body.employee.deleted_at,
        });
        return;
      }
      setError(body.error ?? 'Could not add employee.');
    } finally {
      setPending(false);
    }
  };

  const patch = async (id: string, payload: Record<string, unknown>): Promise<boolean> => {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/bonus/employees/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        refresh();
        return true;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Action failed.');
      return false;
    } finally {
      setPending(false);
    }
  };

  const confirmRehire = async () => {
    if (!rehire) return;
    const ok = await patch(rehire.id, { action: 'reactivate' });
    if (ok) {
      setRehire(null);
      setNewName('');
    }
  };

  const saveRename = async (id: string) => {
    const name = editName.trim();
    if (!name) {
      setError('Enter an employee name.');
      return;
    }
    const ok = await patch(id, { action: 'rename', full_name: name });
    if (ok) {
      setEditingId(null);
      setEditName('');
    }
  };

  return (
    <section className="flex flex-col gap-6" data-testid="bonus-employee-manager">
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="bonus-employee-error"
        >
          {error}
        </p>
      ) : null}

      {rehire ? (
        <div
          className="flex flex-col gap-3 rounded-md border border-dr3-chartreuse/50 bg-dr3-green-dark/40 px-4 py-3"
          role="alertdialog"
          data-testid="bonus-rehire-prompt"
        >
          <p className="text-sm text-dr3-cream">
            <strong>{rehire.name}</strong> was deactivated on {formatDate(rehire.deactivatedAt)}.
            Reactivate this employee instead of creating a duplicate?
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={confirmRehire}
              disabled={pending}
              autoFocus
              className="inline-flex items-center rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink hover:bg-dr3-chartreuse/90 disabled:opacity-50"
              data-testid="bonus-rehire-confirm"
            >
              Reactivate {rehire.name}
            </button>
            <button
              type="button"
              onClick={() => setRehire(null)}
              className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
              data-testid="bonus-rehire-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-medium text-dr3-cream/80">Add employee</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Full name"
            className="rounded-md bg-dr3-green-dark/40 px-3 py-2 text-dr3-cream focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
            data-testid="bonus-employee-new-name"
          />
        </label>
        <button
          type="button"
          onClick={handleAdd}
          disabled={pending}
          className="inline-flex items-center rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink hover:bg-dr3-chartreuse/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="bonus-employee-add"
        >
          + Add
        </button>
      </div>

      <ul className="flex flex-col divide-y divide-dr3-green-dark/40 rounded-md bg-dr3-green-dark/20">
        {employees.length === 0 ? (
          <li className="px-4 py-6 text-sm text-dr3-cream/60" data-testid="bonus-employee-empty">
            No employees match this filter.
          </li>
        ) : (
          employees.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              data-testid="bonus-employee-row"
            >
              <div className="flex flex-col gap-1">
                {editingId === e.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(ev) => setEditName(ev.target.value)}
                      className="rounded-md bg-dr3-green-dark/60 px-2 py-1 text-dr3-cream focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
                      data-testid="bonus-employee-edit-name"
                    />
                    <button
                      type="button"
                      onClick={() => saveRename(e.id)}
                      disabled={pending}
                      className="rounded-md bg-dr3-chartreuse px-3 py-1 text-xs font-semibold text-dr3-ink hover:bg-dr3-chartreuse/90 disabled:opacity-50"
                      data-testid="bonus-employee-edit-save"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="text-xs text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
                      data-testid="bonus-employee-edit-cancel"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <span className="text-sm font-medium text-dr3-cream">{e.full_name}</span>
                )}
                {e.previous_names.length > 0 ? (
                  <span className="text-xs text-dr3-cream/50">
                    Formerly: {e.previous_names.map((p) => p.name).join(', ')}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    e.is_active
                      ? 'bg-dr3-green/30 text-dr3-cream'
                      : 'bg-dr3-green-dark/60 text-dr3-cream/60'
                  }`}
                  data-testid="bonus-employee-status"
                >
                  {e.is_active ? 'Active' : 'Inactive'}
                </span>
                {editingId === e.id ? null : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(e.id);
                        setEditName(e.full_name);
                        setError(null);
                      }}
                      className="rounded-md bg-dr3-green-dark/40 px-3 py-1 text-xs font-medium text-dr3-cream hover:bg-dr3-green-dark/70"
                      data-testid="bonus-employee-rename"
                    >
                      Rename
                    </button>
                    {e.is_active ? (
                      <button
                        type="button"
                        onClick={() => patch(e.id, { action: 'deactivate' })}
                        disabled={pending}
                        className="rounded-md bg-dr3-green-dark/40 px-3 py-1 text-xs font-medium text-dr3-cream hover:bg-red-900/50 disabled:opacity-50"
                        data-testid="bonus-employee-deactivate"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => patch(e.id, { action: 'reactivate' })}
                        disabled={pending}
                        className="rounded-md bg-dr3-green-dark/40 px-3 py-1 text-xs font-medium text-dr3-cream hover:bg-dr3-green/40 disabled:opacity-50"
                        data-testid="bonus-employee-reactivate"
                      >
                        Reactivate
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
