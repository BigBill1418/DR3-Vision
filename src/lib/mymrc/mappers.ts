// ADR-0038 — JSON mappers: Salesforce record representations → mirror rows.
//
// Pure transformation. No Playwright, no DB, no env reads — the JSON these
// consume is captured live and committed as fixtures under `__fixtures__/`, so
// the test suite never needs portal access. When MRC redesigns the portal the
// transport (`portal-client.ts`) throws `PortalContractDriftError`; these
// mappers only ever see well-formed records.
//
// Field provenance (captured live 2026-07-03, DR3 Woodland):
//   Haul_Request__c : Name, Status__c, Rate_ID__c, Docking_Appointment_Date__c,
//                     Docking_Appointment_Time__c ("YYYY/MM/DD HH:MM PT"),
//                     Docking_Appointment_Dock_Door__c
//   Materials__c    : Name, BOL_ID__c, Entry_Date__c, Processed_Date__c,
//                     Shipment_Date__c, Number_of_Program_Units__c,
//                     Outbound_Vendor_Name__c
//
// retrac_id: per ADR post-acceptance note, the Re-TRAC id equals the portal's
// Haul/Materials number (`Name`) in current data — mapped 1:1 here.

import type {
  GetItemsReturnValue,
  HaulMirrorRow,
  OutboundMirrorRow,
  ProcessedMirrorRow,
  SfField,
  SfRecord,
} from './types';

// ── Field accessors ────────────────────────────────────────────────────────

function field(rec: SfRecord, name: string): SfField | undefined {
  return rec.fields[name];
}

/** Raw scalar string value of a field, or null (blank/absent/non-scalar). */
function strVal(rec: SfRecord, name: string): string | null {
  const f = field(rec, name);
  if (!f) return null;
  const v = f.value;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Integer value of a field, or null. Rejects NaN. */
function intVal(rec: SfRecord, name: string): number | null {
  const f = field(rec, name);
  if (!f) return null;
  const v = f.value;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

/** Numeric (decimal) value of a field, or null. */
function numVal(rec: SfRecord, name: string): number | null {
  const f = field(rec, name);
  if (!f) return null;
  const v = f.value;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Date parsing ─────────────────────────────────────────────────────────────

// Salesforce date-only fields carry an ISO `YYYY-MM-DD` value. Anchor at noon
// UTC so the calendar day is identical in UTC and Pacific (no display flip) —
// same convention the retired HTML parser used.
function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return Number.isNaN(ts) ? null : new Date(ts);
}

// Parts formatter to recover the Pacific wall clock a UTC instant shows — the
// same DST-correct technique as `src/lib/time.ts` (replicated here because the
// mymrc module compiles standalone via tsconfig.mymrc.json and cannot import
// `@/lib/time`).
const PACIFIC_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function pacificOffsetMs(at: Date): number {
  const parts = PACIFIC_PARTS_FMT.formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUTC - at.getTime();
}

// The docking appointment time is a plain-text field in PACIFIC:
// "2026/07/03 14:30 PT". Interpret those wall-clock parts as Pacific and
// convert to a true UTC instant (DST-correct). Both facilities operate on
// America/Los_Angeles (see CLAUDE.md), so "PT" is always Pacific.
function parsePacificDateTime(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const approx = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0),
  );
  if (Number.isNaN(approx.getTime())) return null;
  // Correct the wall-clock-as-UTC approximation by the Pacific offset measured
  // at that instant (stable away from the DST seam, which never lands here).
  return new Date(approx.getTime() - pacificOffsetMs(approx));
}

// ── List → record ids ────────────────────────────────────────────────────────

/**
 * Extract the ordered Salesforce record ids from a `getItems` returnValue.
 * These are the feed's lifecycle identity (the mirror `id`); field values are
 * fetched per-record in the detail pass. Ignores null/blank entries.
 */
export function listRecordIds(rv: GetItemsReturnValue): string[] {
  const list = rv.recordIdActionsList;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const id = entry?.recordId;
    if (typeof id === 'string' && id.trim() !== '') ids.push(id);
  }
  return ids;
}

// ── Record → mirror row ──────────────────────────────────────────────────────

export function mapHaulRecord(rec: SfRecord): HaulMirrorRow {
  const name = strVal(rec, 'Name');
  return {
    id: rec.id,
    external_id: name,
    retrac_id: name,
    status: strVal(rec, 'Status__c'),
    rate_id: strVal(rec, 'Rate_ID__c'),
    docking_appointment_at:
      parsePacificDateTime(strVal(rec, 'Docking_Appointment_Time__c')) ??
      parseIsoDate(strVal(rec, 'Docking_Appointment_Date__c')),
    door: strVal(rec, 'Docking_Appointment_Dock_Door__c'),
    units: intVal(rec, 'Number_of_Program_Units__c'),
    weight_lbs: numVal(rec, 'Weight__c'),
    payload: rec,
  };
}

export function mapProcessedRecord(rec: SfRecord): ProcessedMirrorRow {
  const name = strVal(rec, 'Name');
  return {
    id: rec.id,
    external_id: name,
    retrac_id: name,
    bol_id: strVal(rec, 'BOL_ID__c'),
    entry_date: parseIsoDate(strVal(rec, 'Entry_Date__c')),
    processed_date: parseIsoDate(strVal(rec, 'Processed_Date__c')),
    units: intVal(rec, 'Number_of_Program_Units__c'),
    weight_lbs: numVal(rec, 'Weight__c'),
    payload: rec,
  };
}

export function mapOutboundRecord(rec: SfRecord): OutboundMirrorRow {
  const name = strVal(rec, 'Name');
  return {
    id: rec.id,
    external_id: name,
    retrac_id: name,
    bol_id: strVal(rec, 'BOL_ID__c'),
    entry_date: parseIsoDate(strVal(rec, 'Entry_Date__c')),
    shipment_date: parseIsoDate(strVal(rec, 'Shipment_Date__c')),
    vendor: strVal(rec, 'Outbound_Vendor_Name__c'),
    weight_lbs: numVal(rec, 'Weight__c'),
    payload: rec,
  };
}

// Test-only surface for the date helpers (kept out of the public feed API).
export const __mapperInternals = { parseIsoDate, parsePacificDateTime };
