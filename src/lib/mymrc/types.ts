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

/**
 * Outcome of a single per-site scrape — the unit the upsert + ntfy
 * decision rides on. Caller is responsible for calling the upsert
 * function on success and the ntfy publisher on failure.
 */
export interface ScrapeResult {
  site: SiteCode;
  hauls: ScrapedHaul[];
  /** Timestamp when this scrape began. Used as `last_synced_at`. */
  scraped_at: Date;
}

/** Discriminated union for the cron wrapper's per-site outcome reporting. */
export type SiteScrapeOutcome =
  | { site: SiteCode; status: 'ok'; haulCount: number; upserted: number; cancelled: number }
  | { site: SiteCode; status: 'no-credentials' }
  | { site: SiteCode; status: 'error'; error: string };
