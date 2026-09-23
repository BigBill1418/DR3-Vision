// ADR-0135 E — the approver's "equipment not in the list" request, STRUCTURED.
//
// Before this the hatch was one free-text paragraph ("Fix and repair trailer:
// 53489, 5340, 35, 282859 going to Oregon Stores"), which is how work orders,
// four-trailer lists and five naming styles reached the registry. Now the
// approver gives a TYPE and ONE UNIT NUMBER (plus optional make and notes), and
// the request's `description` is written in a fixed, human-readable,
// machine-parseable shape:
//
//   Unit #: 5327
//   Type: Trailer
//   Make: Great Dane
//   Notes: parked at the north fence
//
// Kept as the existing `description` text column (no schema change on the AP
// decide path): it reads naturally on the worklist and in the decision email,
// and `parseEquipmentRequestDescription` gives the resolve panel the fields back
// to pre-fill its search and its create form. PURE — the approver's panel (browser)
// and `createEquipmentRequestInTx` (server) share it.

import {
  ASSET_TYPES,
  assetTypeDef,
  UNIT_NUMBER_MAX,
  type AssetTypeValue,
} from '@/app/admin/constants';
import { unitKey } from './match';

export interface StructuredEquipmentRequest {
  assetType: AssetTypeValue;
  /** Empty only for a type that does not require one (baler, shear, other). */
  unitNumber: string;
  make: string;
  notes: string;
}

const LINE = {
  unit: 'Unit #: ',
  type: 'Type: ',
  make: 'Make: ',
  notes: 'Notes: ',
} as const;

function tidy(v: string): string {
  return v.trim().replace(/\s+/g, ' ');
}

/** Why a structured request is not acceptable, or null when it is. */
export type RequestFieldProblem = 'type' | 'unit_required' | 'unit_invalid' | 'notes_required';

/**
 * What the approver is told when the structured request is not acceptable — one
 * sentence per problem, shown by the approver's panel BEFORE submit and thrown by
 * `createEquipmentRequestInTx` if a request slips past it. `legacy` is the server's
 * answer to a free-text description (a stale page).
 */
export const REQUEST_PROBLEM_MESSAGE: Record<RequestFieldProblem | 'legacy', string> = {
  legacy:
    'The “equipment not in list” form now asks for the type and unit number. Reload the page and fill those in.',
  type: 'Choose what kind of equipment it is.',
  unit_required:
    'Enter the unit number painted on it — trailers, trucks, vans and forklifts need one.',
  unit_invalid:
    'One unit number per request — e.g. 5327, 32-48 or EQ24. For several units, pick each one from the list or file them one at a time.',
  notes_required: 'No unit number? Then add the make or a short note so it can be found.',
};

/**
 * Validate the approver's fields. ONE unit per request: a comma/`and`/`&` list,
 * or a unit field with a space in it (`trailer 5327`, `5327 5340`), is refused —
 * a four-trailer work order is four equipment picks, not one asset.
 * A type with no unit number (a baler) must say something in Notes, or the
 * resolver has nothing to find it by.
 */
export function checkEquipmentRequest(fields: {
  assetType: string;
  unitNumber: string;
  make?: string | undefined;
  notes?: string | undefined;
}): RequestFieldProblem | null {
  const def = assetTypeDef(fields.assetType);
  if (!def) return 'type';
  const unit = tidy(fields.unitNumber).replace(/^#\s*/, '');
  if (unit) {
    if (
      unit.length > UNIT_NUMBER_MAX ||
      /[,;/&\s]/.test(unit) ||
      /\band\b/i.test(unit) ||
      unitKey(unit) === ''
    ) {
      return 'unit_invalid';
    }
  } else if (def.unitRequired) {
    return 'unit_required';
  } else if (!tidy(fields.notes ?? '') && !tidy(fields.make ?? '')) {
    return 'notes_required';
  }
  return null;
}

/** The `description` text for a structured request. Call {@link checkEquipmentRequest} first. */
export function formatEquipmentRequestDescription(fields: {
  assetType: string;
  unitNumber: string;
  make?: string | undefined;
  notes?: string | undefined;
}): string {
  const def = assetTypeDef(fields.assetType);
  const unit = tidy(fields.unitNumber).replace(/^#\s*/, '');
  const lines = [`${LINE.unit}${unit || 'none'}`, `${LINE.type}${def?.label ?? fields.assetType}`];
  const make = tidy(fields.make ?? '');
  if (make) lines.push(`${LINE.make}${make}`);
  const notes = (fields.notes ?? '').trim();
  if (notes) lines.push(`${LINE.notes}${notes}`);
  return lines.join('\n');
}

/**
 * Check, then format — the approver panel's one call. `ok: false` carries the
 * plain-English sentence to show; `ok: true` carries the exact
 * `equipmentRequestDescription` the decide route receives.
 */
export function composeEquipmentRequest(fields: {
  assetType: string;
  unitNumber: string;
  make?: string | undefined;
  notes?: string | undefined;
}):
  | { ok: true; description: string }
  | { ok: false; problem: RequestFieldProblem; message: string } {
  const problem = checkEquipmentRequest(fields);
  if (problem) return { ok: false, problem, message: REQUEST_PROBLEM_MESSAGE[problem] };
  return { ok: true, description: formatEquipmentRequestDescription(fields) };
}

/**
 * The fields back out of a description — or null for a legacy free-text request
 * (every request filed before ADR-0135 E).
 */
export function parseEquipmentRequestDescription(
  description: string,
): StructuredEquipmentRequest | null {
  const lines = description.split('\n');
  const unitLine = lines[0] ?? '';
  const typeLine = lines[1] ?? '';
  if (!unitLine.startsWith(LINE.unit) || !typeLine.startsWith(LINE.type)) return null;
  const label = typeLine.slice(LINE.type.length).trim();
  const def = assetTypeDef(label) ?? findByLabel(label);
  if (!def) return null;
  const unitRaw = unitLine.slice(LINE.unit.length).trim();
  let make = '';
  let notes = '';
  for (let i = 2; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (i === 2 && l.startsWith(LINE.make)) make = l.slice(LINE.make.length).trim();
    else if (l.startsWith(LINE.notes))
      notes = [l.slice(LINE.notes.length), ...lines.slice(i + 1)].join('\n').trim();
    if (notes) break;
  }
  return { assetType: def.value, unitNumber: unitRaw === 'none' ? '' : unitRaw, make, notes };
}

function findByLabel(label: string) {
  const l = label.toLowerCase();
  return ASSET_TYPES.find((t) => t.label.toLowerCase() === l);
}
