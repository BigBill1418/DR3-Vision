// MyMRC ingestion — public surface (ADR-0038 rebuild).
//
// Importers should pull from `@/lib/mymrc` (this file) rather than the
// individual modules so the internal layout can evolve. The Playwright-
// dependent transport (`portal-client.ts`) is exported but only the cron
// worker imports it; the Next.js app process never bundles Playwright.

export { loadAdminCredentials, adminAuthStatePath, CredentialsNotConfiguredError } from './credentials';
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
// wiring, AND the offset-paginating portal adapter that drives it. The getItems
// OFFSET pagination mechanism was CONFIRMED LIVE 2026-07-22 (see list-page.ts) —
// so the adapter (`createBackfillPortalClient` + `playwrightBackfillSession`) is
// no longer INERT; the `scripts/mymrc-backfill.mjs` entrypoint runs it one-shot.
// See OPEN-ITEMS C-24 (now closed).
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
export {
  offsetForPage,
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
  type GetItemsParams,
  type GetItemsPage,
  type AuraFrameworkParams,
  type CapturedListView,
  type CapturedGetItemsRequest,
  type ListViewBinding,
} from './list-page';
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
