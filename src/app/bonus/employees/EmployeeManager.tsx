'use client';

// ADR-0019 §9 + ADR-0026 — Bonus employee management client surface.
//
// Add / rename / set-Employee# / deactivate / reactivate, all via fetch() to
// the gated /api/bonus/employees endpoints + router.refresh() on success
// (CLAUDE.md hard rule #10 — no <form>, no server actions). The server page
// owns the gate and the initial list; this component re-fetches after each
// mutation.
//
// §9a rehire flow: a create that collides with a deactivated record returns
// { rehire_candidate: true, employee } (HTTP 409). We surface a confirm prompt
// — default = reactivate — instead of an error.
//
// ADR-0026 Employee #: an optional 4-digit roster number (only the 21 imported
// legacy Woodland rows carry one). Set on create, edited inline per row.
// Per-site uniqueness among active rows is enforced server-side; a 409 surfaces
// as an inline error. Copy is i18n via the bonus layout's I18nProvider
// (CLAUDE.md hard rule #4).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/provider';

export interface EmployeeRow {
  id: string;
  full_name: string;
  employee_number: string | null;
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
  const t = useT();
  const router = useRouter();
  const [newName, setNewName] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [rehire, setRehire] = useState<RehirePrompt | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // Separate inline editor for the Employee #, independent of the rename editor.
  const [numberEditId, setNumberEditId] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState('');

  const refresh = () => router.refresh();

  const handleAdd = async () => {
    setError(null);
    const name = newName.trim();
    if (!name) {
      setError(t('bonus_employees.add_error_no_name'));
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/bonus/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: name, employee_number: newNumber.trim() || null }),
      });
      if (res.status === 201) {
        setNewName('');
        setNewNumber('');
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
      setError(body.error ?? t('bonus_employees.add_error_generic'));
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
      setError(body.error ?? t('bonus_employees.action_error_generic'));
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
      setNewNumber('');
    }
  };

  const saveRename = async (id: string) => {
    const name = editName.trim();
    if (!name) {
      setError(t('bonus_employees.add_error_no_name'));
      return;
    }
    const ok = await patch(id, { action: 'rename', full_name: name });
    if (ok) {
      setEditingId(null);
      setEditName('');
    }
  };

  const saveNumber = async (id: string) => {
    // Empty string clears the number (sent as null); a value is validated
    // server-side as exactly 4 digits.
    const ok = await patch(id, {
      action: 'set_number',
      employee_number: numberDraft.trim() || null,
    });
    if (ok) {
      setNumberEditId(null);
      setNumberDraft('');
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
          className="flex flex-col gap-3 rounded-md border border-dr3-cyan/40 bg-dr3-space-2/70 px-4 py-3"
          role="alertdialog"
          data-testid="bonus-rehire-prompt"
        >
          <p className="text-sm text-dr3-mist">
            {t('bonus_employees.rehire_body', {
              name: rehire.name,
              date: formatDate(rehire.deactivatedAt),
            })}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={confirmRehire}
              disabled={pending}
              autoFocus
              className="inline-flex items-center rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
              data-testid="bonus-rehire-confirm"
            >
              {t('bonus_employees.rehire_confirm', { name: rehire.name })}
            </button>
            <button
              type="button"
              onClick={() => setRehire(null)}
              className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
              data-testid="bonus-rehire-cancel"
            >
              {t('bonus_employees.rehire_cancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-medium text-dr3-mist-dim">
            {t('bonus_employees.add_label')}
          </span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('bonus_employees.add_name_placeholder')}
            className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim/60 focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
            data-testid="bonus-employee-new-name"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-dr3-mist-dim">
            {t('bonus_employees.employee_number_label')}
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            placeholder={t('bonus_employees.add_number_placeholder')}
            className="w-44 rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim/60 focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
            data-testid="bonus-employee-new-number"
          />
        </label>
        <button
          type="button"
          onClick={handleAdd}
          disabled={pending}
          className="inline-flex items-center rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="bonus-employee-add"
        >
          {t('bonus_employees.add_button')}
        </button>
      </div>

      <ul className="flex flex-col divide-y divide-dr3-steel-light/20 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/50">
        {employees.length === 0 ? (
          <li className="px-4 py-6 text-sm text-dr3-mist-dim" data-testid="bonus-employee-empty">
            {t('bonus_employees.list_empty')}
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
                      className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-2 py-1 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
                      data-testid="bonus-employee-edit-name"
                    />
                    <button
                      type="button"
                      onClick={() => saveRename(e.id)}
                      disabled={pending}
                      className="rounded-md bg-dr3-cyan px-3 py-1 text-xs font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
                      data-testid="bonus-employee-edit-save"
                    >
                      {t('bonus_employees.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="text-xs text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
                      data-testid="bonus-employee-edit-cancel"
                    >
                      {t('bonus_employees.cancel')}
                    </button>
                  </div>
                ) : (
                  <span className="text-sm font-medium text-dr3-mist">{e.full_name}</span>
                )}

                {/* Employee # — inline editor or display + empty state (ADR-0026) */}
                {numberEditId === e.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={numberDraft}
                      onChange={(ev) => setNumberDraft(ev.target.value)}
                      placeholder={t('bonus_employees.edit_number_placeholder')}
                      className="w-28 rounded-md border border-dr3-steel-light/25 bg-dr3-space px-2 py-1 text-dr3-mist placeholder:text-dr3-mist-dim/60 focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
                      data-testid="bonus-employee-number-input"
                    />
                    <button
                      type="button"
                      onClick={() => saveNumber(e.id)}
                      disabled={pending}
                      className="rounded-md bg-dr3-cyan px-3 py-1 text-xs font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
                      data-testid="bonus-employee-number-save"
                    >
                      {t('bonus_employees.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNumberEditId(null)}
                      className="text-xs text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
                      data-testid="bonus-employee-number-cancel"
                    >
                      {t('bonus_employees.cancel')}
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-dr3-mist-dim" data-testid="bonus-employee-number">
                    {t('bonus_employees.employee_number_label')}:{' '}
                    {e.employee_number ? (
                      <span className="font-mono text-dr3-mist">{e.employee_number}</span>
                    ) : (
                      <span className="italic">{t('bonus_employees.employee_number_none')}</span>
                    )}
                  </span>
                )}

                {e.previous_names.length > 0 ? (
                  <span className="text-xs text-dr3-mist-dim">
                    {t('bonus_employees.formerly', {
                      names: e.previous_names.map((p) => p.name).join(', '),
                    })}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    e.is_active
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : 'bg-dr3-steel-light/25 text-dr3-mist-dim'
                  }`}
                  data-testid="bonus-employee-status"
                >
                  {e.is_active
                    ? t('bonus_employees.status_active')
                    : t('bonus_employees.status_inactive')}
                </span>
                {editingId === e.id || numberEditId === e.id ? null : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(e.id);
                        setEditName(e.full_name);
                        setError(null);
                      }}
                      className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1 text-xs font-medium text-dr3-mist hover:bg-dr3-space-2/70 hover:text-dr3-cyan"
                      data-testid="bonus-employee-rename"
                    >
                      {t('bonus_employees.rename')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNumberEditId(e.id);
                        setNumberDraft(e.employee_number ?? '');
                        setError(null);
                      }}
                      className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1 text-xs font-medium text-dr3-mist hover:bg-dr3-space-2/70 hover:text-dr3-cyan"
                      data-testid="bonus-employee-edit-number"
                    >
                      {t('bonus_employees.edit_number')}
                    </button>
                    {e.is_active ? (
                      <button
                        type="button"
                        onClick={() => patch(e.id, { action: 'deactivate' })}
                        disabled={pending}
                        className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1 text-xs font-medium text-dr3-mist hover:border-red-500/40 hover:bg-red-900/40 hover:text-red-100 disabled:opacity-50"
                        data-testid="bonus-employee-deactivate"
                      >
                        {t('bonus_employees.deactivate')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => patch(e.id, { action: 'reactivate' })}
                        disabled={pending}
                        className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1 text-xs font-medium text-dr3-mist hover:border-emerald-400/40 hover:bg-emerald-500/15 hover:text-emerald-200 disabled:opacity-50"
                        data-testid="bonus-employee-reactivate"
                      >
                        {t('bonus_employees.reactivate')}
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
