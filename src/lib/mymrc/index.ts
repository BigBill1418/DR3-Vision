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
} from './mappers';
export {
  createPortalClient,
  AuthFailedError,
  PortalContractDriftError,
  extractListRecordIds,
  extractRecord,
  looksLoggedOut,
  type PortalClient,
  type PortalClientOptions,
} from './portal-client';
export {
  syncFeed,
  syncSite,
  checkDeadman,
  type SyncFeedContext,
  type SyncFeedResult,
  type SyncSiteContext,
} from './sync';
export { ntfyPager, fingerprint, type Pager, type PageAlert, type AlertKind } from './ntfy';
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
  SyncRunStatus,
} from './types';
