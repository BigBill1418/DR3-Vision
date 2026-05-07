// Playwright orchestration for MyMRC scheduled-hauls scraping.
//
// Per ADR-0009, each scrape uses an isolated `BrowserContext` with the
// per-site storage state, navigates to the scheduled-hauls page,
// re-authenticates if MRC redirects to the login page, then hands the
// rendered page HTML to the parser.
//
// Side-effects intentionally separated from the upsert path:
//
//   loadSiteCredentials() -> scrapeSite() -> parseScheduledHaulsHtml()
//                                                                 │
//                                                                 ▼
//                                                       upsertScrapedHauls()
//
// Importing `playwright` is gated to runtime — the module is heavy
// (~50MB resolved) and not available on the edge runtime. The cron
// container uses the Playwright base image so the binaries are
// already present; the Next.js app process never imports this file.

import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { authStatePath } from './credentials';
import { parseScheduledHaulsHtml } from './parser';
import { LOGIN_URL, SELECTORS, scheduledHaulsUrl } from './selectors';
import type { ScrapeResult, ScrapedHaul, SiteCode, SiteCredentials } from './types';

const NAV_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 30_000;
const TABLE_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 DR3VisionScraper/1.0';

export interface ScrapeOptions {
  /** Override storage state path — useful for tests. */
  storageStatePath?: string;
  /** Override navigation timeout. */
  navTimeoutMs?: number;
  /** Optional logger; defaults to `console.info`/`console.warn`. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Run a single per-site scrape. Caller is responsible for browser
 * lifecycle (we accept a `Browser` so the cron wrapper can reuse one
 * across both sites and dispose it cleanly in `finally`).
 *
 * Throws on scrape/login failure so the caller's try/catch routes to
 * ntfy + surfaces the failure to the operator.
 */
export async function scrapeSite(
  browser: Browser,
  creds: SiteCredentials,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const log = opts.log ?? defaultLogger;
  const stateFile = opts.storageStatePath ?? authStatePath(creds.site);
  const navTimeout = opts.navTimeoutMs ?? NAV_TIMEOUT_MS;
  const scrapedAt = new Date();

  // Ensure the state-file parent dir exists; first scrape after a
  // fresh deploy needs to write it.
  await mkdir(dirname(stateFile), { recursive: true });

  const contextOpts: Parameters<Browser['newContext']>[0] = {
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    ...(existsSync(stateFile) ? { storageState: stateFile } : {}),
  };

  const context: BrowserContext = await browser.newContext(contextOpts);
  context.setDefaultNavigationTimeout(navTimeout);
  context.setDefaultTimeout(navTimeout);

  try {
    const page = await context.newPage();
    await page.goto(scheduledHaulsUrl(creds.site), { waitUntil: 'domcontentloaded' });

    if (await isLoginPage(page)) {
      log('info', `mymrc-scrape: login required for ${creds.site}`);
      await login(page, creds, log);
      await page.goto(scheduledHaulsUrl(creds.site), { waitUntil: 'domcontentloaded' });
    }

    if (await isLoginPage(page)) {
      throw new Error(`mymrc-scrape: still on login page after re-auth for ${creds.site}`);
    }

    const hauls = await scrapeTable(page, creds.site, log);

    // Persist the fresh storage state so the NEXT scrape skips the
    // re-auth round-trip. Best-effort — a write failure here doesn't
    // invalidate the scrape we just did.
    try {
      await context.storageState({ path: stateFile });
    } catch (err) {
      log('warn', `mymrc-scrape: storageState write failed: ${describeError(err)}`);
    }

    return { site: creds.site, hauls, scraped_at: scrapedAt };
  } finally {
    try {
      await context.close();
    } catch {
      // Browser teardown failures during cleanup are noise.
    }
  }
}

async function isLoginPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/s\/login(\/|\?|$)/i.test(url)) return true;
  // Salesforce Experience Cloud sometimes redirects via a JS shim that
  // leaves the URL alone but renders the login form into the document.
  // Detect the form's username field as the canonical post-redirect
  // signal.
  const usernameVisible = await page
    .locator(SELECTORS.loginRedirectMarker)
    .first()
    .isVisible()
    .catch(() => false);
  return usernameVisible;
}

async function login(
  page: Page,
  creds: SiteCredentials,
  log: NonNullable<ScrapeOptions['log']>,
): Promise<void> {
  if (!page.url().includes('/login')) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.locator(SELECTORS.loginEmailField).first().fill(creds.username);
  await page.locator(SELECTORS.loginPasswordField).first().fill(creds.password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: LOGIN_TIMEOUT_MS }),
    page.locator(SELECTORS.loginSubmitButton).first().click(),
  ]);
  log('info', `mymrc-scrape: login submitted for ${creds.site}`);
}

async function scrapeTable(
  page: Page,
  site: SiteCode,
  log: NonNullable<ScrapeOptions['log']>,
): Promise<ScrapedHaul[]> {
  // Wait for either the table OR an empty-state marker. A "no upcoming
  // hauls" page is a valid scrape — the operator's queue should reflect
  // that immediately and the cancel-stale path will clear any rows
  // that disappeared.
  await Promise.race([
    page
      .locator(`${SELECTORS.scheduledHaulsTable}, ${SELECTORS.scheduledHaulsTableFallback}`)
      .first()
      .waitFor({ state: 'attached', timeout: TABLE_TIMEOUT_MS })
      .catch(() => undefined),
    page
      .locator(SELECTORS.scheduledHaulsEmptyState)
      .first()
      .waitFor({ state: 'attached', timeout: TABLE_TIMEOUT_MS })
      .catch(() => undefined),
  ]);
  const html = await page.content();
  const hauls = parseScheduledHaulsHtml(html);
  log('info', `mymrc-scrape: parsed ${hauls.length} hauls for ${site}`);
  return hauls;
}

function defaultLogger(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error' || level === 'warn') {
    console.warn(message);
    return;
  }
  console.log(message);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
