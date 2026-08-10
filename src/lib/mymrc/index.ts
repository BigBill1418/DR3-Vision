// MyMRC ingestion — public surface (ADR-0038 rebuild).
//
// Importers should pull from `@/lib/mymrc` (this file) rather than the
// individual modules so the internal layout can evolve. The Playwright-
// dependent transport (`portal-client.ts`) is exported but only the cron
// worker imports it; the Next.js app process never bundles Playwright.

export {
  loadAdminCredentials,
  adminAuthStatePath,
  CredentialsNotConfiguredError,
} from './credentials';
export {
  setMymrcCredentials,
  getMymrcCredentials,
  getMymrcCredentialStatus,
  InvalidCredentialInputError,
  CredentialKeyUnavailableError,
  CredentialDecryptError,
  type MymrcCredentials,
  type MymrcCredentialStatus,
} from './credential-store';
export { upsertScrapedHauls, type UpsertSummary, type UpsertContext } from './upsert';
export {
  listRecordIds,
  mapHaulRecord,
  mapProcessedRecord,
  mapOutboundRecord,
  mapDockAvailabilityRecord,
  classifyMaterialsType,
  type OutboundMapOptions,
} from './mappers';
export {
  createPortalClient,
  openAdminSession,
  AuthFailedError,
  PortalContractDriftError,
  extractListRecordIds,
  extractRecord,
  detailUrl,
  looksLoggedOut,
  type PortalClient,
  type PortalClientOptions,
  type ListRecordIdsResult,
  type AdminSession,
} from './portal-client';
export {
  syncFeed,
  syncSite,
  checkDeadman,
  type SyncFeedContext,
  type SyncFeedResult,
  type SyncSiteContext,
} from './sync';
// Windowed historical backfill (ADR-0057 D3). The engine, its production target
// wiring, AND the SORT-FLIP-paginating portal adapter that drives it. Plain offset
// pagination TRUNCATED the two big views at the SOQL OFFSET 2000 ceiling (2050
// rows); sort-flip (asc+desc by Id, pageSize 2000, getCount) pages the full
// history when totalCount ≤ 8000 — CONFIRMED LIVE 2026-07-22 (see list-page.ts).
// The `scripts/mymrc-backfill.mjs` entrypoint runs it one-shot.
export {
  runBackfill,
  type BackfillPortalClient,
  type BackfillTarget,
  type BackfillListPage,
  type BackfillContext,
  type BackfillResult,
  type BackfillTargetResult,
  type BackfillStatus,
} from './backfill';
export { buildBackfillTargets } from './backfill-targets';
export {
  createBackfillPortalClient,
  playwrightBackfillSession,
  type BackfillSession,
  type BackfillPortalClientOptions,
} from './backfill-portal-client';
// Batched getRecordWithFields billing-field capture (ADR-0057 D3 addendum,
// 2026-07-22). Replaces the racy per-record `/s/detail/<id>` navigation with a
// direct multi-action Aura POST (~100 ids/POST) reusing the list-page envelope.
export {
  createRecordFieldsClient,
  playwrightRecordFieldsSession,
  buildGetRecordWithFieldsMessage,
  buildGetRecordWithFieldsFormFields,
  parseGetRecordWithFieldsResponse,
  optionalFieldsForFeed,
  chunkIds,
  GETRECORD_WITH_FIELDS_DESCRIPTOR,
  HAUL_OPTIONAL_FIELDS,
  MATERIALS_OPTIONAL_FIELDS,
  DOCK_OPTIONAL_FIELDS,
  type RecordFieldsClient,
  type RecordFieldsSession,
  type RecordFieldsClientOptions,
  type BatchFetchResult,
  type BatchParseResult,
  type BatchActionError,
} from './record-fields-client';
export {
  enrichDetails,
  sweepTargetDetail,
  type EnrichContext,
  type EnrichResult,
  type EnrichTargetResult,
  type DetailSweepResult,
  type SweepOptions,
} from './enrich-details';
export {
  offsetForPage,
  sortFlipStep,
  sortFlipLastPageIndex,
  sortFlipExceedsCoverage,
  buildGetItemsMessage,
  buildGetItemsFormFields,
  parseGetItemsResponse,
  parseGetItemsRequest,
  parseAuraPostData,
  messageIsGetItems,
  correlateCapturedListViews,
  resolveFilterName,
  BACKFILL_LIST_VIEWS,
  GETITEMS_DESCRIPTOR,
  DEFAULT_PAGE_SIZE,
  BACKFILL_PAGE_SIZE,
  SORT_FLIP_STEP_COUNT,
  type GetItemsParams,
  type GetItemsPage,
  type AuraFrameworkParams,
  type CapturedListView,
  type CapturedGetItemsRequest,
  type ListViewBinding,
} from './list-page';
// Steady-state NEWEST-FIRST list pagination (2026-07-31). The passive
// interception transport read the list view's DEFAULT (ascending) window, so the
// hourly sync re-read the OLDEST 50 records forever and the processed/outbound
// mirrors froze for 9 days while every run reported `ok`. This wraps a
// PortalClient so its list pass replays `getItems` with `sortBy:'-Id'` over a
// bounded page budget instead.
export {
  withNewestFirstList,
  fetchNewestFirstListPage,
  plannedOffsets,
  paginationFromEnv,
  OFFSET_CEILING,
  DEFAULT_SYNC_PAGE_SIZE,
  DEFAULT_SYNC_MAX_PAGES,
  type PaginatedListOptions,
  type PaginatedListResult,
} from './list-sync-client';
// Mirror freshness (2026-07-31) — measures whether what we HOLD is current,
// independent of whether the scraper threw. The guard that would have caught the
// 9-day freeze; every pre-existing guard was blind to it by construction.
export {
  checkMirrorFreshness,
  measureFeedFreshness,
  assessFreshness,
  freshnessFingerprint,
  FRESHNESS_COLUMN,
  DEFAULT_MAX_AGE_MS,
  FRESHNESS_COOLDOWN_MS,
  type FeedFreshness,
} from './freshness';
export { ntfyPager, fingerprint, type Pager, type PageAlert, type AlertKind } from './ntfy';
export {
  detectProcessedRecordChanges,
  detectHaulRecordChanges,
  extractSourceName,
  extractHaulSourceName,
  normalizeSourceName,
  type ReconciliationCandidate,
  type MirrorTable,
  type ProcessedMirrorRecord,
  type HaulMirrorRecord,
  type SourceRow,
  type SourceAliasRow,
} from './reconcile-detect';
export {
  feedReconciliationQueue,
  type FeedReconciliationContext,
  type FeedReconciliationResult,
  type FeedLogger,
} from './reconcile-feed';
// ADR-0058 — processed → inventory bridge (mymrc_processed_mirror →
// processed_units_daily, the Stripped leg). Runs on scrape completion (hourly) and
// one-shot for backfill; precedence-guarded + audited + double-count-proof.
export {
  bridgeProcessedToInventory,
  type ProcessedBridgeContext,
  type ProcessedBridgeResult,
  type BridgeLogger,
} from './processed-bridge';
// ADR-0059 — hauls → inventory INBOUND bridge (mymrc_hauls_mirror Delivered/General →
// inbound_loads, the PROVISIONAL Inbound leg). Runs on scrape completion (hourly) and
// one-shot for backfill; precedence-guarded (paper_bulk wins) + audited +
// double-count-proof. Filters `status='Delivered'` and does NOT exclude
// `disappeared_at` — the inverse of the processed bridge.
export {
  bridgeInboundHaulsToInventory,
  findDatelessDeliveredHauls,
  type InboundBridgeContext,
  type InboundBridgeResult,
  type DatelessDeliveredHaul,
} from './inbound-bridge';
export {
  SELECTORS,
  SELECTOR_VERSION,
  LOGIN_URL,
  AUTHED_HOME_URL,
  PORTAL_ORIGIN,
  OBJECT_NAV_SLUGS,
} from './selectors';
export { SITE_CODES, FEED_NAMES } from './types';
export type {
  SiteCode,
  SiteCredentials,
  FeedName,
  SfRecord,
  SfField,
  HaulMirrorRow,
  ProcessedMirrorRow,
  OutboundMirrorRow,
  DockAvailabilityMirrorRow,
  SyncRunStatus,
} from './types';
