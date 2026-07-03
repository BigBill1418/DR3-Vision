'use client';

// ADR-0017 — admin Settings panel: create-user client form.
//
// CLAUDE.md hard rule #10 — no `<form>` element, no submit handler;
// everything posts via `onClick`.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminMessages as M } from '@/app/admin/messages';
import { PROCESSOR_ROLES } from '@/app/admin/constants';

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

type Role = 'operator' | 'manager' | 'admin';

interface Props {
  sites: SiteOption[];
}

export function UserCreateForm({ sites }: Props) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [email, setEmail] = useState('');
  const [siteId, setSiteId] = useState<string>(sites[0]?.id ?? '');
  const [processorRole, setProcessorRole] = useState<string>('');
  const [allSites, setAllSites] = useState(false);
  const [canManageRates, setCanManageRates] = useState(false);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const eugeneId = sites.find((s) => s.code === 'eugene')?.id;
  const showProcessorRole = role === 'operator' && siteId === eugeneId;

  const handleSubmit = async () => {
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
    if (!siteId) {
      setError(M.form.siteRequired);
      return;
    }
    if (role === 'operator') {
      if (!/^\d{4}$/.test(pin)) {
        setError(M.form.pinPattern);
        return;
      }
      if (pin !== pinConfirm) {
        setError(M.form.pinMismatch);
        return;
      }
    }

    setPending(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          role,
          email: email.trim() || null,
          primary_site_id: siteId,
          processor_role: showProcessorRole ? processorRole || null : null,
          all_sites: role === 'manager' ? allSites : false,
          can_manage_rates: role === 'manager' ? canManageRates : false,
          pin: role === 'operator' ? pin : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.errors.serverError);
        return;
      }
      router.push('/admin/users');
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-5">
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="admin-create-error"
        >
          {error}
        </p>
      ) : null}

      <Field label={M.form.nameLabel}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-create-name"
        />
      </Field>

      <Field label={M.form.roleLabel}>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-create-role"
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
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-create-email"
        />
      </Field>

      <Field
        label={M.form.siteLabel}
        helper={role === 'admin' ? M.form.siteHelpAdmin : M.form.siteHelpManager}
      >
        <select
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-create-site"
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
            className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
            data-testid="admin-create-processor-role"
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
        <label className="flex items-start gap-3" data-testid="admin-create-all-sites-field">
          <input
            type="checkbox"
            checked={allSites}
            onChange={(e) => setAllSites(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-dr3-steel-light/40 bg-dr3-space-2 text-dr3-cyan focus:ring-2 focus:ring-dr3-cyan"
            data-testid="admin-create-all-sites"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-medium text-dr3-mist">{M.form.allSitesLabel}</span>
            <span className="text-xs text-dr3-mist-dim">{M.form.allSitesHelp}</span>
          </span>
        </label>
      ) : null}

      {role === 'manager' ? (
        <label className="flex items-start gap-3" data-testid="admin-create-can-manage-rates-field">
          <input
            type="checkbox"
            checked={canManageRates}
            onChange={(e) => setCanManageRates(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-dr3-steel-light/40 bg-dr3-space-2 text-dr3-cyan focus:ring-2 focus:ring-dr3-cyan"
            data-testid="admin-create-can-manage-rates"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-medium text-dr3-mist">{M.form.canManageRatesLabel}</span>
            <span className="text-xs text-dr3-mist-dim">{M.form.canManageRatesHelp}</span>
          </span>
        </label>
      ) : null}

      {role === 'operator' ? (
        <>
          <Field label={M.form.pinLabel} helper={M.form.pinHelp}>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
              data-testid="admin-create-pin"
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
              className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
              data-testid="admin-create-pin-confirm"
            />
          </Field>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-create-submit"
        >
          {M.form.submitCreate}
        </button>
        <button
          type="button"
          onClick={() => router.push('/admin/users')}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          data-testid="admin-create-cancel"
        >
          {M.form.cancel}
        </button>
      </div>
    </section>
  );
}

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
