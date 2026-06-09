'use client';

// ADR-0017 — admin Settings panel: edit-user client form.
//
// CLAUDE.md hard rule #10 — no `<form>` element, no submit handler;
// every action is a `<button onClick>`.
// Three sub-surfaces in one panel: edit-fields, reset-PIN modal,
// deactivate/reactivate. Each fires its own PATCH against the
// discriminated-union API.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AdminUserDto } from '@/lib/admin-users';
import { PROCESSOR_ROLES } from '@/app/admin/constants';
import { adminMessages as M } from '@/app/admin/messages';

interface SiteOption {
  id: string;
  code: string;
  name: string;
}
type Role = 'operator' | 'manager' | 'admin';

interface Props {
  user: AdminUserDto;
  sites: SiteOption[];
  isSelf: boolean;
}

export function UserEditForm({ user, sites, isSelf }: Props) {
  const router = useRouter();

  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [email, setEmail] = useState(user.email ?? '');
  const [siteId, setSiteId] = useState<string>(user.primary_site_id ?? sites[0]?.id ?? '');
  const [processorRole, setProcessorRole] = useState<string>(user.processor_role ?? '');
  const [allSites, setAllSites] = useState<boolean>(user.all_sites);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinSuccess, setPinSuccess] = useState<string | null>(null);

  const eugeneId = sites.find((s) => s.code === 'eugene')?.id;
  const showProcessorRole = role === 'operator' && siteId === eugeneId;

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError(M.form.nameRequired);
      return;
    }
    if ((role === 'manager' || role === 'admin') && !email.trim()) {
      setError(M.form.emailRequired);
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(M.form.emailInvalid);
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          name: name.trim(),
          role,
          email: email.trim() || null,
          primary_site_id: siteId,
          processor_role: showProcessorRole ? processorRole || null : null,
          all_sites: role === 'manager' ? allSites : false,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.errors.serverError);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  const handleDeactivate = async () => {
    if (!window.confirm(M.edit.deactivateConfirm)) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
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
      setPending(false);
    }
  };

  const handleReactivate = async () => {
    if (!window.confirm(M.edit.reactivateConfirm)) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
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
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-8">
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="admin-edit-error"
        >
          {error}
        </p>
      ) : null}

      {/* ── Identity + role fields ── */}
      <div className="flex flex-col gap-5">
        <Field label={M.form.nameLabel}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            data-testid="admin-edit-name"
          />
        </Field>
        <Field label={M.form.roleLabel}>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className={inputCls}
            data-testid="admin-edit-role"
          >
            <option value="operator" className="text-dr3-space">
              {M.form.roleOperator}
            </option>
            <option value="manager" className="text-dr3-space">
              {M.form.roleManager}
            </option>
            <option value="admin" className="text-dr3-space">
              {M.form.roleAdmin}
            </option>
          </select>
        </Field>
        <Field
          label={M.form.emailLabel}
          helper={role === 'operator' ? M.form.emailHelpOperator : M.form.emailHelpManager}
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
            data-testid="admin-edit-email"
          />
        </Field>
        <Field label={M.form.siteLabel}>
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className={inputCls}
            data-testid="admin-edit-site"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id} className="text-dr3-space">
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {showProcessorRole ? (
          <Field label={M.form.processorRoleLabel} helper={M.form.processorRoleHelp}>
            <select
              value={processorRole}
              onChange={(e) => setProcessorRole(e.target.value)}
              className={inputCls}
              data-testid="admin-edit-processor-role"
            >
              <option value="" className="text-dr3-space">
                {M.form.processorRoleNone}
              </option>
              {PROCESSOR_ROLES.map((p) => (
                <option key={p} value={p} className="text-dr3-space">
                  {p}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {role === 'manager' ? (
          <label className="flex items-start gap-3" data-testid="admin-edit-all-sites-field">
            <input
              type="checkbox"
              checked={allSites}
              onChange={(e) => setAllSites(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-dr3-steel-light/40 bg-dr3-space-2 text-dr3-cyan focus:ring-2 focus:ring-dr3-cyan"
              data-testid="admin-edit-all-sites"
            />
            <span className="flex flex-col gap-1">
              <span className="text-sm font-medium text-dr3-mist">{M.form.allSitesLabel}</span>
              <span className="text-xs text-dr3-mist-dim">{M.form.allSitesHelp}</span>
            </span>
          </label>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="admin-edit-submit"
          >
            {M.form.submitUpdate}
          </button>
          <button
            type="button"
            onClick={() => router.push('/admin/users')}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
            data-testid="admin-edit-cancel"
          >
            {M.form.cancel}
          </button>
        </div>
      </div>

      {/* ── Reset PIN (operators only) ── */}
      {role === 'operator' ? (
        <section
          className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4"
          data-testid="admin-edit-pin-section"
        >
          <h2 className="text-lg font-semibold">{M.edit.resetPinHeading}</h2>
          <p className="text-xs text-dr3-mist-dim">{M.edit.resetPinHelper}</p>
          {pinSuccess ? (
            <p className="text-sm text-emerald-200" data-testid="admin-edit-pin-success">
              {pinSuccess}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setPinSuccess(null);
              setShowPinModal(true);
            }}
            className="self-start rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-1.5 text-sm text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan"
            data-testid="admin-edit-pin-open"
          >
            {M.edit.resetPinButton}
          </button>
        </section>
      ) : null}

      {/* ── Deactivate / reactivate ── */}
      <section className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4">
        <h2 className="text-lg font-semibold">{M.edit.deactivateHeading}</h2>
        <p className="text-xs text-dr3-mist-dim">{M.edit.deactivateHelper}</p>
        {isSelf ? (
          <p className="text-sm text-dr3-mist-dim" data-testid="admin-edit-self-deactivate-notice">
            {M.edit.cannotSelfDeactivate}
          </p>
        ) : user.is_active ? (
          <button
            type="button"
            onClick={handleDeactivate}
            disabled={pending}
            className="self-start rounded-md bg-red-900/40 px-3 py-1.5 text-sm text-red-100 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="admin-edit-deactivate"
          >
            {M.edit.deactivateButton}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleReactivate}
            disabled={pending}
            className="self-start rounded-md bg-emerald-900/40 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="admin-edit-reactivate"
          >
            {M.edit.reactivateButton}
          </button>
        )}
      </section>

      {showPinModal ? (
        <ResetPinModal
          userId={user.id}
          onClose={() => setShowPinModal(false)}
          onSuccess={() => {
            setShowPinModal(false);
            setPinSuccess(M.edit.resetPinSuccess);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function ResetPinModal({
  userId,
  onClose,
  onSuccess,
}: {
  userId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    if (!/^\d{4}$/.test(pin)) {
      setError(M.form.pinPattern);
      return;
    }
    if (pin !== pinConfirm) {
      setError(M.form.pinMismatch);
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_pin', pin }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.errors.serverError);
        return;
      }
      onSuccess();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-dr3-mist shadow-xl"
        role="dialog"
        aria-modal="true"
        data-testid="admin-edit-pin-modal"
      >
        <h3 className="text-lg font-semibold">{M.edit.resetPinHeading}</h3>
        {error ? (
          <p
            className="rounded-md bg-red-900/40 px-3 py-1.5 text-sm text-red-100"
            role="alert"
            data-testid="admin-edit-pin-error"
          >
            {error}
          </p>
        ) : null}
        <Field label={M.form.pinLabel} helper={M.form.pinHelp}>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className={inputCls}
            data-testid="admin-edit-pin-new"
          />
        </Field>
        <Field label={M.form.pinConfirmLabel}>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={pinConfirm}
            onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className={inputCls}
            data-testid="admin-edit-pin-confirm"
          />
        </Field>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
            data-testid="admin-edit-pin-cancel"
          >
            {M.form.cancel}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="admin-edit-pin-submit"
          >
            {M.edit.resetPinSubmit}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan';

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-dr3-mist">{label}</span>
      {children}
      {helper ? <span className="text-xs text-dr3-mist-dim">{helper}</span> : null}
    </label>
  );
}
