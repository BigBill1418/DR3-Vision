'use client';

// ADR-0063 — admin equipment master: edit form + activate/deactivate.
//
// CLAUDE.md hard rule #10 — no `<form>`, no submit handler.
//
// Save uses `router.push(backHref)` so the admin lands back on the filtered
// list; the activate/deactivate buttons stay on the page and `router.refresh()`
// instead, so the admin can flip status and keep editing.
//
// EVERY field is editable, including `site_id` on assets an AP approval already
// cites. An earlier revision disabled that select; ADR-0046 Amendment 7 made
// the approver's picker fleet-wide, so `site_id` no longer gates who can select
// the asset and the lock only stood between an admin and the coarse seed data
// (C-28) this screen exists to correct. See ADR-0063 D4.
//
// The AP-citation count is still surfaced — not as a restriction, but so the
// admin can see an edit is touching an asset that financial approvals point at.
//
// ADR-0135 — the site select gains "Fleet-wide" (`site_id: null`, an asset with
// no home yard); the structured identity (unit #, make, VIN/serial) is editable;
// and the merge section offers EVERY live asset in the fleet as the survivor,
// asking where the survivor lives when the two sit at different yards.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { EquipmentCategory } from '@prisma/client';
// `AdminEquipmentDto` is a TYPE-only import (erased at compile time, so it does
// not pull the server-only module in); the runtime constants come from the
// pure-data constants module.
import type { AdminEquipmentDto } from '@/lib/admin-equipment';
import {
  DISPLAY_NAME_MAX,
  EQUIPMENT_CATEGORIES,
  MAKE_MAX,
  UNIT_NUMBER_MAX,
  VIN_SERIAL_MAX,
} from '@/app/admin/constants';
import { adminMessages as M } from '@/app/admin/messages';
import { CATEGORY_LABEL } from '../labels';
import { FLEET_SITE_CODE } from '../list-url';
import { MergePanel, type MergeReferenceCounts, type MergeRow } from '../MergePanel';

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  equipment: AdminEquipmentDto;
  sites: SiteOption[];
  backHref?: string | undefined;
  /** Every live asset in the fleet except this one — the merge survivors. */
  mergeCandidates?: MergeRow[] | undefined;
  /** What merging THIS row away would move, table by table. */
  referenceCounts?: MergeReferenceCounts | undefined;
}

const INPUT_CLASS =
  'rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan';

export function EquipmentEditForm({
  equipment,
  sites,
  backHref = '/admin/equipment',
  mergeCandidates,
  referenceCounts,
}: Props) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(equipment.display_name);
  const [category, setCategory] = useState<EquipmentCategory>(equipment.category);
  const [site, setSite] = useState(equipment.site_id ?? FLEET_SITE_CODE);
  const [unitNumber, setUnitNumber] = useState(equipment.unit_number ?? '');
  const [make, setMake] = useState(equipment.make ?? '');
  const [vinSerial, setVinSerial] = useState(equipment.vin_serial ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/equipment/${equipment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? M.errors.serverError);
        return false;
      }
      return true;
    } finally {
      setPending(false);
    }
  };

  const handleSave = async () => {
    const name = displayName.trim();
    if (!name) {
      setError(M.equipment.nameRequired);
      return;
    }
    if (name.length > DISPLAY_NAME_MAX) {
      setError(M.equipment.nameTooLong);
      return;
    }
    // Identity fields ride along only when changed: an empty string CLEARS on
    // the server, so resending an untouched blank would be harmless, but an
    // unchanged value never needs re-validating.
    const changed = (next: string, prev: string | null) =>
      next.trim() !== (prev ?? '') ? next.trim() : undefined;
    if (
      await patch({
        action: 'update',
        display_name: name,
        category,
        site_id: site === FLEET_SITE_CODE ? null : site,
        unit_number: changed(unitNumber, equipment.unit_number),
        make: changed(make, equipment.make),
        vin_serial: changed(vinSerial, equipment.vin_serial),
      })
    ) {
      router.push(backHref);
      router.refresh();
    }
  };

  const handleSetActive = async (action: 'deactivate' | 'reactivate') => {
    if (action === 'deactivate' && !window.confirm(M.equipment.confirmDeactivate)) return;
    if (await patch({ action })) router.refresh();
  };

  return (
    <section className="flex flex-col gap-5">
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="admin-equipment-edit-error"
        >
          {error}
        </p>
      ) : null}

      <p className="text-xs text-dr3-mist-dim" data-testid="admin-equipment-link-count">
        {equipment.link_count > 0
          ? M.equipment.linkedApprovalsNote(equipment.link_count)
          : M.equipment.noLinkedApprovals}
      </p>

      <Field label={M.equipment.nameLabel} helper={M.equipment.nameHelp}>
        <input
          type="text"
          value={displayName}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-edit-name"
        />
      </Field>

      <Field label={M.equipment.categoryLabel} helper={M.equipment.categoryHelp}>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as EquipmentCategory)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-edit-category"
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
          value={site}
          onChange={(e) => setSite(e.target.value)}
          className={INPUT_CLASS}
          data-testid="admin-equipment-edit-site"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id} className="text-dr3-space">
              {s.name}
            </option>
          ))}
          <option value={FLEET_SITE_CODE} className="text-dr3-space">
            {M.equipment.fleetWide}
          </option>
        </select>
      </Field>

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label={M.equipment.unitLabel} helper={M.equipment.unitHelpOptional}>
          <input
            type="text"
            value={unitNumber}
            maxLength={UNIT_NUMBER_MAX}
            onChange={(e) => setUnitNumber(e.target.value)}
            className={INPUT_CLASS}
            data-testid="admin-equipment-edit-unit"
          />
        </Field>
        <Field label={M.equipment.makeLabel} helper={M.equipment.makeHelp}>
          <input
            type="text"
            value={make}
            maxLength={MAKE_MAX}
            onChange={(e) => setMake(e.target.value)}
            className={INPUT_CLASS}
            data-testid="admin-equipment-edit-make"
          />
        </Field>
        <Field label={M.equipment.vinLabel} helper={M.equipment.vinHelp}>
          <input
            type="text"
            value={vinSerial}
            maxLength={VIN_SERIAL_MAX}
            onChange={(e) => setVinSerial(e.target.value)}
            className={INPUT_CLASS}
            data-testid="admin-equipment-edit-vin"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-equipment-edit-submit"
        >
          {M.equipment.submitUpdate}
        </button>
        <button
          type="button"
          onClick={() => router.push(backHref)}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          data-testid="admin-equipment-edit-cancel"
        >
          {M.equipment.cancel}
        </button>
      </div>

      {mergeCandidates && !equipment.merged_into_id ? (
        <section className="mt-4 flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-5">
          <h2 className="text-lg font-semibold">{M.equipment.mergeHeading}</h2>
          {notice ? (
            <p
              className="rounded-md bg-emerald-900/40 px-4 py-2 text-sm text-emerald-100"
              role="status"
              data-testid="admin-equipment-edit-merge-notice"
            >
              {notice}
            </p>
          ) : (
            <MergePanel
              loser={equipment}
              candidates={mergeCandidates}
              sites={sites}
              counts={referenceCounts}
              onMerged={(n) => {
                setNotice(M.equipment.mergeSuccess(n));
                router.refresh();
              }}
            />
          )}
        </section>
      ) : null}

      <section className="mt-4 flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-5">
        <h2 className="text-lg font-semibold">{M.equipment.deactivateHeading}</h2>
        <p className="text-sm text-dr3-mist-dim">{M.equipment.deactivateHelper}</p>
        {equipment.is_active ? (
          <button
            type="button"
            onClick={() => handleSetActive('deactivate')}
            disabled={pending}
            className="self-start rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="admin-equipment-edit-deactivate"
          >
            {M.equipment.deactivateButton}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => handleSetActive('reactivate')}
            disabled={pending}
            className="self-start rounded-md bg-emerald-900/40 px-4 py-2 text-sm text-emerald-100 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="admin-equipment-edit-reactivate"
          >
            {M.equipment.reactivateButton}
          </button>
        )}
      </section>
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
