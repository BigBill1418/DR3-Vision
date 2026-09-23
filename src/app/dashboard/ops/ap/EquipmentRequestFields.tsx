'use client';

// ADR-0135 E — the approver's "Equipment not in list" request, STRUCTURED.
//
// Replaces Amendment 9's free-text paragraph, which is how work orders
// ("Fix and repair trailer: 53489, 5340, 35, 282859 …"), four-trailer lists and
// five naming styles reached the registry. The approver now gives a TYPE and ONE
// unit number (plus optional make and notes); `composeEquipmentRequest` checks
// the fields with the same rule the server enforces and writes the fixed
// `Unit #: / Type: / Make: / Notes:` text into the unchanged
// `equipmentRequestDescription` field. Controlled component — the panel owns the
// state so the three equipment dispositions stay mutually exclusive.
//
// No `<form>` (CLAUDE.md hard rule #10): plain inputs, the panel's Approve button
// does the submitting.

import { ASSET_TYPES, MAKE_MAX, UNIT_NUMBER_MAX, assetTypeDef } from '@/app/admin/constants';
import { composeEquipmentRequest } from '@/lib/equipment/request-description';

export interface EquipmentRequestDraft {
  assetType: string;
  unitNumber: string;
  make: string;
  notes: string;
}

export const EMPTY_EQUIPMENT_REQUEST: EquipmentRequestDraft = {
  assetType: '',
  unitNumber: '',
  make: '',
  notes: '',
};

/**
 * Room left for the notes once the header lines are written, so the composed
 * text stays under the route's 2,000-character `EQUIPMENT_REQUEST_DESCRIPTION_MAX`
 * (unit ≤ 40 + type + make ≤ 60 + labels is well under 200).
 */
const NOTES_MAX = 1800;

const INPUT = 'mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white';

export function EquipmentRequestFields({
  value,
  onChange,
}: {
  value: EquipmentRequestDraft;
  onChange: (next: EquipmentRequestDraft) => void;
}) {
  const set = (patch: Partial<EquipmentRequestDraft>) => onChange({ ...value, ...patch });
  const def = assetTypeDef(value.assetType);
  const touched = Object.values(value).some((v) => v.trim() !== '');
  const result = composeEquipmentRequest(value);

  return (
    <div
      className="mt-1 rounded border border-dr3-cyan/40 bg-dr3-cyan/10 p-2"
      data-testid="ap-equipment-request-fields"
    >
      <p className="opacity-90">
        Request ONE asset — give its type and the unit number painted on it. Morena and Rick will
        add it to the fleet. For several units, pick each from the list instead; if one is missing,
        request it here and pick the rest.
      </p>

      <label className="mt-2 block">
        Type <span className="text-amber-300">(required)</span>
        <select
          value={value.assetType}
          onChange={(e) => set({ assetType: e.target.value })}
          className={INPUT}
          data-testid="ap-equipment-request-type"
        >
          <option value="" className="text-black">
            Choose…
          </option>
          {ASSET_TYPES.map((t) => (
            <option key={t.value} value={t.value} className="text-black">
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-2 block">
        Unit #{' '}
        <span className="text-amber-300">
          {def?.unitRequired === false ? '(if it has one)' : '(required — one unit only)'}
        </span>
        <input
          value={value.unitNumber}
          onChange={(e) => set({ unitNumber: e.target.value })}
          maxLength={UNIT_NUMBER_MAX}
          placeholder="e.g. 5327, 32-48 or EQ24"
          className={INPUT}
          data-testid="ap-equipment-request-unit"
        />
      </label>

      <label className="mt-2 block">
        Make <span className="opacity-60">(optional)</span>
        <input
          value={value.make}
          onChange={(e) => set({ make: e.target.value })}
          maxLength={MAKE_MAX}
          placeholder="e.g. Great Dane, Hyster"
          className={INPUT}
          data-testid="ap-equipment-request-make"
        />
      </label>

      <label className="mt-2 block">
        Notes{' '}
        <span className="opacity-60">
          {def && !def.unitRequired && !value.unitNumber.trim()
            ? '(required without a unit # — unless you gave the make)'
            : '(optional)'}
        </span>
        <textarea
          value={value.notes}
          onChange={(e) => set({ notes: e.target.value })}
          rows={2}
          maxLength={NOTES_MAX}
          placeholder="Anything that helps find it — the nickname the crew uses, where it's parked"
          className={INPUT}
          data-testid="ap-equipment-request-notes"
        />
      </label>

      {touched && !result.ok && (
        <p
          className="mt-2 text-amber-200"
          aria-live="polite"
          data-testid="ap-equipment-request-problem"
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
