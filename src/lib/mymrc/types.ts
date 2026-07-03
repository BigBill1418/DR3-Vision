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

/** The three ingestion feeds. Values match `mymrc_sync_runs.feed`. */
export type FeedName = 'hauls' | 'processed' | 'outbound';

export const FEED_NAMES: readonly FeedName[] = ['hauls', 'processed', 'outbound'] as const;

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

export interface HaulMirrorRow extends MirrorBase {
  status: string | null;
  rate_id: string | null;
  docking_appointment_at: Date | null;
  door: string | null;
  units: number | null;
}

export interface ProcessedMirrorRow extends MirrorBase {
  bol_id: string | null;
  entry_date: Date | null;
  processed_date: Date | null;
  units: number | null;
}

export interface OutboundMirrorRow extends MirrorBase {
  bol_id: string | null;
  entry_date: Date | null;
  shipment_date: Date | null;
  vendor: string | null;
}

export type MirrorRow = HaulMirrorRow | ProcessedMirrorRow | OutboundMirrorRow;

/** Terminal status of one per-site-per-feed sync run — mirrors `MymrcSyncStatus`. */
export type SyncRunStatus = 'ok' | 'auth_failed' | 'contract_drift' | 'error';
