// MyMRC scrape worker — public surface.
//
// Importers should pull from `@/lib/mymrc` (this file) rather than the
// individual modules so the internal layout can evolve. The Playwright-
// dependent surface (`scrape.ts`) is exported but only the cron worker
// imports it; the Next.js app process never bundles Playwright.

export { loadSiteCredentials, authStatePath } from './credentials';
export { parseScheduledHaulsHtml } from './parser';
export { upsertScrapedHauls, type UpsertSummary, type UpsertContext } from './upsert';
export { scrapeSite, type ScrapeOptions } from './scrape';
export {
  SELECTORS,
  SELECTOR_VERSION,
  scheduledHaulsUrl,
  LOGIN_URL,
} from './selectors';
export { SITE_CODES } from './types';
export type {
  SiteCode,
  SiteCredentials,
  ScrapedHaul,
  ScrapeResult,
  SiteScrapeOutcome,
} from './types';
