// MyMRC scrape types — shared across selectors, parser, scrape, upsert.
//
// Two terms in play:
//   - "site code"  — DR3-Vision's internal identifier ('eugene' | 'woodland')
//   - "MyMRC site" — what MRC's portal calls the recycler ('DR3 Eugene' | 'DR3 Woodland')
//
// The scrape worker runs once per site code; selectors + URLs are derived
// from the site code at startup time. Operator-facing runbook + env vars
// use the site code form.

export type SiteCode = 'eugene' | 'woodland';

export const SITE_CODES: readonly SiteCode[] = ['eugene', 'woodland'] as const;

/**
 * Per-site MyMRC credential pair. Sourced from env vars at scrape time;
 * never logged, never persisted. The `site` field is the DR3-Vision site
 * code, NOT the MyMRC display name.
 */
export interface SiteCredentials {
  site: SiteCode;
  username: string;
  password: string;
}

/**
 * One scraped haul row from the MyMRC scheduled-hauls table. The fields
 * mirror what the parser extracts; downstream upsert maps them onto the
 * `expected_loads` row shape (which adds FKs to `sources` /
 * `transporters` and the audit metadata).
 */
export interface ScrapedHaul {
  /** Verbatim from MyMRC, e.g. "H-126152". Required — match key. */
  external_mymrc_haul_id: string;
  /** Parsed from "Recycler Reported Delivery Date" (MM/DD/YYYY) into a UTC Date at noon. */
  expected_arrival_at: Date;
  /** Verbatim Collection Site name from MyMRC. Match key against `sources.name`. */
  source_name: string;
  /** Verbatim Transporter name. Optional — some rows lack one. */
  transporter_name: string | null;
  /** Recycler Program Unit Count. Optional. */
  expected_unit_count: number | null;
  /** Reference Number from MyMRC. Optional. */
  bol_number: string | null;
  /** Optional `scheduled_at_mymrc` if the table exposes it; usually null on the scheduled-hauls view. */
  scheduled_at_mymrc: Date | null;
}

// `ScrapedHaul` above is consumed by the `expected_loads` feed (upsert.ts). The
// old scrape-result / per-site-outcome types were retired with the DOM scraper;
// the ADR-0038 transport returns typed records via `portal-client.ts` instead.

// ════════════════════════════════════════════════════════════════════════
// ADR-0038 — MyMRC JSON transport + mirror types
// ════════════════════════════════════════════════════════════════════════

/**
 * The ingestion feeds. Values match `mymrc_sync_runs.feed` (a plain String
 * column, so adding one needs no migration).
 *
 * `hauls` and `haulsCompleted` are TWO VIEWS OVER ONE MIRROR
 * (`mymrc_hauls_mirror`), and that is the whole point of the second one:
 * `docking_appointments_rc` lists hauls while they are SCHEDULED, and a haul
 * LEAVES that view when MRC marks it Delivered. Without a second feed reading
 * `completed_hauls`, the mirror never observes the transition — which is exactly
 * how the delivered half froze for nine days (2026-07-22 → 07-31) while the
 * active half refreshed hourly and everything looked healthy.
 *
 * Two views over one mirror has a consequence that must never be forgotten:
 * "not in this list" NO LONGER MEANS "gone". See `markDisappeared` in `sync.ts`.
 */
export type FeedName = 'hauls' | 'haulsCompleted' | 'processed' | 'outbound';

export const FEED_NAMES: readonly FeedName[] = [
  'hauls',
  'haulsCompleted',
  'processed',
  'outbound',
] as const;

/**
 * One field of a Salesforce UI-API RecordRepresentation. `value` is the raw
 * typed value (string | number | boolean | null, or a nested record); some
 * fields also carry a human `displayValue`. Captured live 2026-07-03.
 */
export interface SfField {
  displayValue: string | null;
  value: unknown;
}

/**
 * A Salesforce UI-API RecordRepresentation, as returned by
 * `RecordUiController/ACTION$getRecordWithFields`. Only the members the mappers
 * read are typed; the raw record is retained verbatim in the mirror `payload`.
 */
export interface SfRecord {
  apiName: string;
  id: string;
  fields: Record<string, SfField>;
}

/**
 * The `getItems` returnValue from `ListViewDataManagerController`. The portal's
 * virtualized grid returns record ids + column metadata here; cell VALUES load
 * per-record via `getRecordWithFields` (the detail pass). We depend only on
 * `recordIdActionsList` (the ordered set of Salesforce record ids in the feed).
 */
export interface GetItemsReturnValue {
  recordIdActionsList?: Array<{ recordId?: string | null } | null> | null;
  isErrorListView?: boolean | null;
  /**
   * The ListView is windowed: `true` means the portal returned only a page and
   * MORE records exist beyond `recordIdActionsList`. The Aura returnValue carries
   * no absolute total — this boolean (+ `offset`) is the only completeness signal.
   * A `true` here means the extracted id set is NOT the full feed, which matters
   * for disappeared-detection (a partial list would over-mark rows as gone).
   */
  hasMoreData?: boolean | null;
}

/**
 * Common lifecycle columns every mirror upsert sets. `id` is the Salesforce
 * record id (the upsert key, always present from the list feed).
 */
interface MirrorBase {
  id: string;
  external_id: string | null; // portal number (H-… / M-…), from the detail pass
  retrac_id: string | null;
  weight_lbs: number | null;
  payload: unknown;
}

// Field provenance below is the REAL Phase-0 object catalog
// (docs/mymrc-discovery-2026-07-22.md). Every Salesforce field is a
// `{displayValue, value}` pair; mappers read `value` for identity/number/date,
// and `displayValue` only where it is the canonical human label.
export interface HaulMirrorRow extends MirrorBase {
  status: string | null; // Status__c
  type: string | null; // Type__c — docking-appointment vs consumer/illegal drop-off discriminator
  rate_id: string | null; // Rate_ID__c (denormalized landfill-transporter-recycler descriptor)
  recycler_name: string | null; // Recycling_Center_Lookup__r.Name — SITE discriminator (→ site_id on detail)
  recycler_account_id: string | null; // Recycling_Center_Lookup__c — 18-char Account id (structured join)
  transporter_name: string | null; // Transporter__c — account-name string (denormalized, NOT an FK)
  collection_site: string | null; // Collection_Site__c — expected_loads source-name join key
  collection_source: string | null; // Collection_Source__c
  commodity: string | null; // Commodity__c
  container_type: string | null; // Container_Type__c — RAW value (typographic apostrophe; normalize before compare)
  program_unit_count: number | null; // Recycler_Program_Unit_Count__c — billing-authoritative
  non_program_unit_count: number | null; // Recycler_Non_Program_Unit_Count__c
  unpaid_consumer_dropoff_units: number | null; // Unpaid_Consumer_Drop_Off_Units__c
  docking_appointment_date: Date | null; // Docking_Appointment_Date__c (Date, noon-UTC)
  docking_appointment_at: Date | null; // parsed from free-text Docking_Appointment_Time__c ("2026/07/20 12:00 PT")
  door: string | null; // Docking_Appointment_Dock_Door__c
  // ADR-0089 Am.1 — the TRUE delivery date (primary inbound key; the dock date is
  // a scheduling field, null on all 886 collection-network hauls and wrong by up
  // to a week even when present). Proven populated live 2026-08-10.
  recycler_reported_delivery_date: Date | null; // Recycler_Reported_Delivery_Date__c (Date, noon-UTC)
  transporter_reported_delivery_date: Date | null; // Transporter_Reported_Delivery_Date__c — defensive; null in practice
  unit_count_at_unload: number | null; // Unit_Count_at_Unload__c — physical receipt count (F-3 groundwork)
  units: number | null; // legacy back-compat mirror of program_unit_count (program_unit_count is authoritative)
}

export interface ProcessedMirrorRow extends MirrorBase {
  type: string | null; // Type__c (expected 'Processing')
  account_name: string | null; // Account__r.Name — SITE discriminator (→ site_id on detail)
  account_id: string | null; // Account__c — 18-char Account id (structured join)
  materials_status: string | null; // Materials_Status__c
  bol_id: string | null; // BOL_ID__c
  entry_date: Date | null; // Entry_Date__c
  processed_date: Date | null; // Processed_Date__c
  program_unit_count: number | null; // Number_of_Program_Units__c (billable count)
  non_program_unit_count: number | null; // Number_of_Non_Program_Units__c
  units: number | null; // legacy back-compat mirror of program_unit_count
}

export interface OutboundMirrorRow extends MirrorBase {
  type: string | null; // Type__c (expected 'Outbound')
  account_name: string | null; // Account__r.Name — SITE discriminator (→ site_id on detail)
  account_id: string | null; // Account__c — 18-char Account id (structured join)
  materials_status: string | null; // Materials_Status__c
  bol_id: string | null; // BOL_ID__c
  vendor: string | null; // Outbound_Vendor_Name__c — LIST-ONLY (absent from the record detail; see mappers.ts)
  entry_date: Date | null; // Entry_Date__c
  shipment_date: Date | null; // no real Materials field — stays null (kept, forward-compatible)
  program_unit_count: number | null; // Number_of_Program_Units__c
  non_program_unit_count: number | null; // Number_of_Non_Program_Units__c
}

/**
 * Dock_Availability_Schedule__c (a1t) — NEW non-billing scheduling object.
 * No site discriminator exists in its 14-field set (no site_id column). Slot
 * times are Salesforce Time strings ("07:00:00.000Z"), NOT datetimes — kept as
 * strings verbatim. Multipicklists (day_of_week codes, container_type) are stored
 * RAW ";"-joined per the schema; membership splitting is a downstream concern.
 */
export interface DockAvailabilityMirrorRow {
  id: string; // Salesforce record id (a1t…)
  external_id: string | null; // Name ("DA-900001") → external_schedule_id column
  status: string | null; // Status__c
  day_of_week: string | null; // Day_of_Week__c — RAW value ";"-joined numeric codes ("1;2;3;4;5")
  container_type: string | null; // Container_Type__c — RAW value ";"-joined multipicklist
  dock_door: string | null; // Dock_Door__c value ("Dock Door 1"), NOT displayValue ("Schedule 1")
  slot_start_time: string | null; // Slot_Start_Time__c — SF Time text ("07:00:00.000Z")
  slot_end_time: string | null; // Slot_End_Time__c — SF Time text
  available_appointments: number | null; // Number_of_Available_Appointments__c
  availability_start_date: Date | null; // Availability_Start_Date__c (Date, noon-UTC)
  payload: unknown; // FULL raw record representation
}

export type MirrorRow = HaulMirrorRow | ProcessedMirrorRow | OutboundMirrorRow;

/** Terminal status of one per-site-per-feed sync run — mirrors `MymrcSyncStatus`. */
/**
 * Run outcomes on the `mymrc_sync_runs` ledger.
 *
 * `stale_mirror` (added 2026-07-31) exists because `ok` used to cover a run that
 * accomplished nothing: for 9 days the processed/outbound runs listed 50 ids,
 * fetched 0 details, gained 0 rows and recorded `ok`, while the mirror they
 * maintain did not advance a single day. A run now records `stale_mirror` when
 * the feed's newest business record is older than the freshness threshold — so
 * `ok` on this ledger means "the mirror is current", not merely "the scraper
 * did not throw".
 */
export type SyncRunStatus = 'ok' | 'auth_failed' | 'contract_drift' | 'stale_mirror' | 'error';
