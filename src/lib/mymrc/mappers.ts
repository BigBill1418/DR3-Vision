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
  DockAvailabilityMirrorRow,
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

// ── Relationship (__r) fields ─────────────────────────────────────────────────

/** Narrow an unknown to a nested Salesforce RecordRepresentation (from a __r field's `value`). */
function isNestedRecord(v: unknown): v is { fields: Record<string, SfField> } {
  return (
    !!v &&
    typeof v === 'object' &&
    'fields' in v &&
    typeof (v as { fields: unknown }).fields === 'object' &&
    (v as { fields: unknown }).fields !== null
  );
}

/**
 * Read the `Name` of a related record from a `__r` relationship field. The
 * nested record lives under `value` ({apiName,id,fields:{Name:{value}}}); the
 * relationship field's own `displayValue` is the related Name too and is used as
 * a fallback. Returns null when absent/blank — a missing relationship never
 * throws (the record simply lacks that link).
 */
function relatedName(rec: SfRecord, relField: string): string | null {
  const f = field(rec, relField);
  if (!f) return null;
  if (isNestedRecord(f.value)) {
    const nameField = f.value.fields['Name'];
    const v = nameField?.value;
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  if (typeof f.displayValue === 'string' && f.displayValue.trim() !== '') return f.displayValue;
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
  // Billing-authoritative haul count is Recycler_Program_Unit_Count__c (a HAUL
  // field). `units` is the legacy generic column; mirror the authoritative count
  // into it so the existing expected_loads feed (which reads `units`) is correct.
  const programUnits = intVal(rec, 'Recycler_Program_Unit_Count__c');
  return {
    id: rec.id,
    external_id: name, // → external_haul_id
    retrac_id: name,
    status: strVal(rec, 'Status__c'),
    type: strVal(rec, 'Type__c'),
    rate_id: strVal(rec, 'Rate_ID__c'),
    recycler_name: relatedName(rec, 'Recycling_Center_Lookup__r'),
    recycler_account_id: strVal(rec, 'Recycling_Center_Lookup__c'),
    transporter_name: strVal(rec, 'Transporter__c'),
    collection_site: strVal(rec, 'Collection_Site__c'),
    collection_source: strVal(rec, 'Collection_Source__c'),
    commodity: strVal(rec, 'Commodity__c'),
    container_type: strVal(rec, 'Container_Type__c'),
    program_unit_count: programUnits,
    non_program_unit_count: intVal(rec, 'Recycler_Non_Program_Unit_Count__c'),
    unpaid_consumer_dropoff_units: intVal(rec, 'Unpaid_Consumer_Drop_Off_Units__c'),
    docking_appointment_date: parseIsoDate(strVal(rec, 'Docking_Appointment_Date__c')),
    // Free-text Pacific wall-clock preferred; fall back to the date-only field.
    docking_appointment_at:
      parsePacificDateTime(strVal(rec, 'Docking_Appointment_Time__c')) ??
      parseIsoDate(strVal(rec, 'Docking_Appointment_Date__c')),
    door: strVal(rec, 'Docking_Appointment_Dock_Door__c'),
    units: programUnits,
    weight_lbs: numVal(rec, 'Recycler_Weight__c'),
    payload: rec,
  };
}

export function mapProcessedRecord(rec: SfRecord): ProcessedMirrorRow {
  const name = strVal(rec, 'Name');
  const programUnits = intVal(rec, 'Number_of_Program_Units__c');
  return {
    id: rec.id,
    external_id: name, // → external_materials_id
    retrac_id: name,
    type: strVal(rec, 'Type__c'),
    account_name: relatedName(rec, 'Account__r'),
    account_id: strVal(rec, 'Account__c'),
    materials_status: strVal(rec, 'Materials_Status__c'),
    bol_id: strVal(rec, 'BOL_ID__c'),
    entry_date: parseIsoDate(strVal(rec, 'Entry_Date__c')),
    processed_date: parseIsoDate(strVal(rec, 'Processed_Date__c')),
    program_unit_count: programUnits,
    non_program_unit_count: intVal(rec, 'Number_of_Non_Program_Units__c'),
    units: programUnits,
    // Materials__c carries NO weight field (verified Phase-0) — always null.
    weight_lbs: null,
    payload: rec,
  };
}

/**
 * Options for {@link mapOutboundRecord}. `vendor` (Outbound_Vendor_Name__c) is a
 * LIST-ONLY column: it appears in the getItems list-view columns but NOT in the
 * getRecordWithFields detail field set (verified Phase-0 — see the Materials
 * discovery metadata). The record detail therefore cannot yield it. When the list
 * pass captures a per-id vendor, thread it in here; otherwise it falls back to the
 * (normally absent) record field, then null.
 */
export interface OutboundMapOptions {
  vendor?: string | null;
}

export function mapOutboundRecord(rec: SfRecord, opts: OutboundMapOptions = {}): OutboundMirrorRow {
  const name = strVal(rec, 'Name');
  const programUnits = intVal(rec, 'Number_of_Program_Units__c');
  const vendor =
    opts.vendor !== undefined ? opts.vendor : strVal(rec, 'Outbound_Vendor_Name__c');
  return {
    id: rec.id,
    external_id: name, // → external_materials_id
    retrac_id: name,
    type: strVal(rec, 'Type__c'),
    account_name: relatedName(rec, 'Account__r'),
    account_id: strVal(rec, 'Account__c'),
    materials_status: strVal(rec, 'Materials_Status__c'),
    bol_id: strVal(rec, 'BOL_ID__c'),
    vendor,
    entry_date: parseIsoDate(strVal(rec, 'Entry_Date__c')),
    // No real Shipment_Date__c field on Materials — read defensively (forward-
    // compatible), yields null on real data.
    shipment_date: parseIsoDate(strVal(rec, 'Shipment_Date__c')),
    program_unit_count: programUnits,
    non_program_unit_count: intVal(rec, 'Number_of_Non_Program_Units__c'),
    // Materials__c carries NO weight field (verified Phase-0) — always null.
    weight_lbs: null,
    payload: rec,
  };
}

/**
 * Classify a Materials__c record by its `Type__c` value. Processed and Outbound
 * are ONE Salesforce object (a2L) split at ingest by this field — the same record
 * id can appear under both list views, so routing/validation keys on Type__c, not
 * the list view. Returns the raw picklist value ('Processing' | 'Outbound') or,
 * for an unrecognized/absent value, `null` (caller decides how to handle drift).
 */
export function classifyMaterialsType(rec: SfRecord): 'Processing' | 'Outbound' | null {
  const t = strVal(rec, 'Type__c');
  if (t === 'Processing') return 'Processing';
  if (t === 'Outbound') return 'Outbound';
  return null;
}

/**
 * Map a Dock_Availability_Schedule__c record → mirror row. Reads `value` for
 * every field: Day_of_Week__c value = numeric codes ("1;2;3;4;5") NOT the
 * "Monday;…" displayValue; Dock_Door__c value = "Dock Door 1" NOT the "Schedule 1"
 * displayValue. Slot times are Salesforce Time strings kept verbatim (never
 * Date.parse'd). Multipicklists are stored raw ";"-joined.
 */
export function mapDockAvailabilityRecord(rec: SfRecord): DockAvailabilityMirrorRow {
  return {
    id: rec.id,
    external_id: strVal(rec, 'Name'), // → external_schedule_id
    status: strVal(rec, 'Status__c'),
    day_of_week: strVal(rec, 'Day_of_Week__c'),
    container_type: strVal(rec, 'Container_Type__c'),
    dock_door: strVal(rec, 'Dock_Door__c'),
    slot_start_time: strVal(rec, 'Slot_Start_Time__c'),
    slot_end_time: strVal(rec, 'Slot_End_Time__c'),
    available_appointments: intVal(rec, 'Number_of_Available_Appointments__c'),
    availability_start_date: parseIsoDate(strVal(rec, 'Availability_Start_Date__c')),
    payload: rec,
  };
}

// Test-only surface for the date + relationship helpers (kept out of the public feed API).
export const __mapperInternals = { parseIsoDate, parsePacificDateTime, relatedName };
