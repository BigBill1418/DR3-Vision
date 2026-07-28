'use client';

// ADR-0063 — admin equipment master: create form.
//
// CLAUDE.md hard rule #10 — no `<form>` element, no submit handler; everything
// posts via `onClick`.
//
// Two contracts inherited from ADR-0017 Amendment 1, deliberately built in
// from day one rather than retrofitted:
//   1. save AND cancel return to `backHref` — the list WITH the admin's
//      filters — never a bare `/admin/equipment`;
//   2. the site select seeds from the list's `?site=` filter, not `sites[0]`.
//      `orderBy: { name: 'asc' }` makes `sites[0]` always DR3 Eugene, so
//      creating from a Woodland-scoped list would silently register the asset
//      in Eugene. That is a hard-rule-#2 site-separation defect, not a
//      cosmetic default: the asset would surface in the wrong site's AP
//      approver picker.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { EquipmentCategory } from '@prisma/client';
// Pure-data constants module — a value import from `@/lib/admin-equipment`
// would pull Prisma into the client bundle.
import { DISPLAY_NAME_MAX, EQUIPMENT_CATEGORIES } from '@/app/admin/constants';
import { adminMessages as M } from '@/app/admin/messages';
import { CATEGORY_LABEL } from '../labels';

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  sites: SiteOption[];
  /** Where save/cancel return to — the list *with the admin's filters*. */
  backHref?: string | undefined;
  /** Site code the list was filtered to, if any. Seeds the site select. */
  initialSiteCode?: string | undefined;
  /** Category the list was filtered to, if any. Seeds the category select. */
  initialCategory?: EquipmentCategory | undefined;
}

export function EquipmentCreateForm({
  sites,
  backHref = '/admin/equipment',
  initialSiteCode,
  initialCategory,
}: Props) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState<EquipmentCategory>(initialCategory ?? 'vehicle');
  const [siteId, setSiteId] = useState<string>(
    () => sites.find((s) => s.code === initialSiteCode)?.id ?? sites[0]?.id ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async () => {
    setError(null);

    const name = displayName.trim();
    if (!name) {
      setError(M.equipment.nameRequired);
      return;
    }
    if (name.length > DISPLAY_NAME_MAX) {
      setError(M.equipment.nameTooLong);
      return;
    }
    if (!siteId) {
      setError(M.equipment.siteRequired);
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/admin/equipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: siteId, display_name: name, category }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.errors.serverError);
        return;
      }
      router.push(backHref);
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
          data-testid="admin-equipment-create-error"
        >
          {error}
        </p>
      ) : null}

      <Field label={M.equipment.nameLabel} helper={M.equipment.nameHelp}>
        <input
          type="text"
          value={displayName}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-create-name"
        />
      </Field>

      <Field label={M.equipment.categoryLabel} helper={M.equipment.categoryHelp}>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as EquipmentCategory)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-create-category"
        >
          {EQUIPMENT_CATEGORIES.map((c) => (
            <option key={c} value={c} className="text-dr3-space">
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </Field>

      <Field label={M.equipment.siteLabel} helper={M.equipment.siteHelp}>
        <select
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-create-site"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id} className="text-dr3-space">
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-equipment-create-submit"
        >
          {M.equipment.submitCreate}
        </button>
        <button
          type="button"
          onClick={() => router.push(backHref)}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          data-testid="admin-equipment-create-cancel"
        >
          {M.equipment.cancel}
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
