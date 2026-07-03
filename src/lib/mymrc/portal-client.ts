// ADR-0038 — MyMRC portal transport. THE ONLY module that touches Playwright /
// the Salesforce session. Everything above it consumes typed JSON, so the next
// portal redesign touches this file alone.
//
// Transport ladder (decided empirically during 2026-07-03 discovery — see the
// ADR-0038 "Post-acceptance implementation notes"): ladder #2, in-page Aura
// response interception. Playwright logs in, navigates to each feed's list page
// / a record's detail page, and we intercept the `/s/sfsites/aura` responses the
// page itself issues:
//   - list  → `ListViewDataManagerController/getItems` returnValue → record ids
//   - detail→ `RecordUiController/getRecordWithFields` returnValue → record rep
// Interception was chosen over ladder #1 (raw fetch replay) because the browser
// reconstructs the fwuid/token envelope for us — immune to the per-release
// `fwuid` drift that ladder #1 reintroduces. Ladder #1's transport is proven
// viable (a captured Aura POST replayed with fresh cookies returned 200 + JSON)
// and documented as the future fast-path.
//
// Loud failure (ADR-0038 D4): a missing expected action throws
// PortalContractDriftError; a login/404/logged-out shell throws AuthFailedError.
// A green run with no data is impossible by construction.

import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { authStatePath } from './credentials';
import { listRecordIds } from './mappers';
import { LOGIN_URL, SELECTORS } from './selectors';
import type { FeedName, GetItemsReturnValue, SiteCredentials, SfRecord } from './types';

// ── Typed errors ─────────────────────────────────────────────────────────────

/** Session is not authenticated (login page, 404/logged-out shell, or re-login failed). */
export class AuthFailedError extends Error {
  override readonly name = 'AuthFailedError';
  constructor(message: string) {
    super(message);
  }
}

/** The Aura envelope did not contain an expected action/shape (fwuid drift, portal redesign). */
export class PortalContractDriftError extends Error {
  override readonly name = 'PortalContractDriftError';
  constructor(message: string) {
    super(message);
  }
}

// ── Feed URLs ────────────────────────────────────────────────────────────────

const FEED_LIST_PATH: Record<FeedName, string> = {
  hauls: '/s/hauls',
  processed: '/s/processed-materials',
  outbound: '/s/outbound-materials',
};

const PORTAL_ORIGIN = 'https://mrc-us.my.site.com';

function listUrl(feed: FeedName): string {
  return `${PORTAL_ORIGIN}${FEED_LIST_PATH[feed]}`;
}

// Generic Experience Cloud record view. Works across objects; if a per-object
// route differs, the record's getRecordWithFields still fires for this id and
// interception catches it. A wrong URL degrades to a loud
// PortalContractDriftError (no getRecordWithFields), never a silent empty.
function detailUrl(recordId: string): string {
  return `${PORTAL_ORIGIN}/s/detail/${encodeURIComponent(recordId)}`;
}

// ── Pure parse layer (fixture-tested; no Playwright) ─────────────────────────

const AURA_URL_RE = /\/s\/sfsites\/aura/i;

interface AuraAction {
  id?: string;
  state?: string;
  returnValue?: unknown;
}

/** Parse an intercepted Aura response body into its actions (tolerant of junk). */
export function parseAuraActions(body: string): AuraAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const actions = (parsed as { actions?: unknown }).actions;
  return Array.isArray(actions) ? (actions as AuraAction[]) : [];
}

function isGetItemsReturnValue(v: unknown): v is GetItemsReturnValue {
  return !!v && typeof v === 'object' && 'recordIdActionsList' in v;
}

/**
 * Find the first getItems returnValue across intercepted Aura bodies and return
 * its record ids. Throws PortalContractDriftError when no such action is present
 * (the whole point of D4 — never return a silent empty list).
 */
export function extractListRecordIds(bodies: readonly string[], feed: FeedName): string[] {
  for (const body of bodies) {
    for (const action of parseAuraActions(body)) {
      if (action.state === 'SUCCESS' && isGetItemsReturnValue(action.returnValue)) {
        const rv = action.returnValue;
        if (rv.isErrorListView === true) {
          throw new PortalContractDriftError(`${feed}: list view reported isErrorListView=true`);
        }
        return listRecordIds(rv);
      }
    }
  }
  throw new PortalContractDriftError(
    `${feed}: no ListViewDataManager getItems action found in ${bodies.length} Aura response(s)`,
  );
}

function looksLikeRecord(o: unknown): o is SfRecord {
  if (!o || typeof o !== 'object') return false;
  const r = o as { apiName?: unknown; id?: unknown; fields?: unknown };
  if (typeof r.apiName !== 'string' || typeof r.id !== 'string' || !r.fields) return false;
  if (typeof r.fields !== 'object') return false;
  return Object.values(r.fields as Record<string, unknown>).some(
    (f) => !!f && typeof f === 'object' && ('displayValue' in f || 'value' in f),
  );
}

/**
 * Recursively locate the RecordRepresentation for `recordId` across intercepted
 * Aura bodies (getRecordWithFields; the record may be nested inside a larger
 * envelope). Returns the RICHEST match (most fields) for that id. Throws
 * PortalContractDriftError when the record is absent.
 */
export function extractRecord(bodies: readonly string[], recordId: string): SfRecord {
  let best: SfRecord | null = null;
  const consider = (rec: SfRecord): void => {
    if (rec.id !== recordId) return;
    if (!best || Object.keys(rec.fields).length > Object.keys(best.fields).length) best = rec;
  };
  const walk = (o: unknown, depth: number): void => {
    if (!o || typeof o !== 'object' || depth > 14) return;
    if (looksLikeRecord(o)) consider(o);
    if (Array.isArray(o)) {
      for (const v of o) walk(v, depth + 1);
      return;
    }
    for (const v of Object.values(o as Record<string, unknown>)) walk(v, depth + 1);
  };
  for (const body of bodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    walk(parsed, 0);
  }
  if (!best) {
    throw new PortalContractDriftError(
      `record ${recordId}: no getRecordWithFields representation found in ${bodies.length} Aura response(s)`,
    );
  }
  return best;
}

/**
 * Pure logged-out predicate (ADR-0038 D4). Detects the login form AND the
 * 404/logged-out error page ("Error" title + "404 Error… Log in" body) that the
 * old scraper mis-read as an empty-but-ok result. `usernameFieldVisible` is the
 * Playwright signal; `url`/`html` are the page state.
 */
export function looksLoggedOut(input: {
  url: string;
  html: string;
  usernameFieldVisible: boolean;
}): boolean {
  if (input.usernameFieldVisible) return true;
  if (/\/s\/login(\/|\?|$)/i.test(input.url)) return true;
  const html = input.html;
  // 404 / expired-session shell: title "Error" plus a "404 Error" body and a
  // login link — the exact page the ADR calls out.
  const has404 = /\b404\s*error\b/i.test(html);
  const hasLoginLink = /log\s*in/i.test(html) && /\/s\/login/i.test(html);
  const errorTitle = /<title>\s*error\s*<\/title>/i.test(html);
  if (has404 && hasLoginLink) return true;
  if (errorTitle && hasLoginLink) return true;
  // A visible login form in the markup (JS-shim redirect that leaves the URL).
  if (/placeholder="Username"/i.test(html) && /type="password"/i.test(html)) return true;
  return false;
}

// ── Playwright transport ─────────────────────────────────────────────────────

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 6_000; // late Aura datatable / LDS fetches
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 DR3VisionScraper/1.0';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;

const noopLog: Logger = () => undefined;

export interface PortalClientOptions {
  storageStatePath?: string;
  navTimeoutMs?: number;
  settleMs?: number;
  log?: Logger;
}

/**
 * The transport contract the sync engine depends on. Kept minimal so tests can
 * substitute a fake and never touch Playwright.
 */
export interface PortalClient {
  fetchListRecordIds(feed: FeedName): Promise<string[]>;
  fetchRecordDetail(feed: FeedName, recordId: string): Promise<SfRecord>;
  close(): Promise<void>;
}

/**
 * Log in (reusing persisted storage state when present) and return a
 * session-bound PortalClient. One re-login is attempted on a logged-out shell,
 * then AuthFailedError. Caller owns the `Browser`; `close()` disposes the
 * context (and persists fresh storage state).
 */
export async function createPortalClient(
  browser: Browser,
  creds: SiteCredentials,
  opts: PortalClientOptions = {},
): Promise<PortalClient> {
  const log = opts.log ?? noopLog;
  const navTimeout = opts.navTimeoutMs ?? NAV_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const stateFile = opts.storageStatePath ?? authStatePath(creds.site);
  await mkdir(dirname(stateFile), { recursive: true });

  const context: BrowserContext = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    ...(existsSync(stateFile) ? { storageState: stateFile } : {}),
  });
  context.setDefaultNavigationTimeout(navTimeout);
  context.setDefaultTimeout(navTimeout);
  const page = await context.newPage();

  async function usernameVisible(): Promise<boolean> {
    return page
      .locator(SELECTORS.loginRedirectMarker)
      .first()
      .isVisible()
      .catch(() => false);
  }

  async function isLoginPage(): Promise<boolean> {
    return looksLoggedOut({
      url: page.url(),
      html: await page.content().catch(() => ''),
      usernameFieldVisible: await usernameVisible(),
    });
  }

  async function ensureAuthenticated(targetUrl: string): Promise<void> {
    if (!(await isLoginPage())) return;
    log('info', `mymrc: login required (${creds.site})`);
    await login(page, creds, log);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    if (await isLoginPage()) {
      throw new AuthFailedError(`mymrc: still logged out after re-auth (${creds.site})`);
    }
  }

  // Navigate and collect every intercepted Aura response body during load+settle.
  async function collectAura(url: string): Promise<string[]> {
    const bodies: string[] = [];
    const onResponse = (resp: Awaited<ReturnType<Page['waitForResponse']>>): void => {
      if (!AURA_URL_RE.test(resp.url())) return;
      resp
        .text()
        .then((t) => bodies.push(t))
        .catch(() => undefined);
    };
    page.on('response', onResponse);
    try {
      await page.goto(url, { waitUntil: 'networkidle' }).catch((e: unknown) => {
        log('warn', `mymrc: goto ${url} — ${describeError(e)}`);
      });
      await page.waitForTimeout(settleMs);
    } finally {
      page.off('response', onResponse);
    }
    return bodies;
  }

  return {
    async fetchListRecordIds(feed: FeedName): Promise<string[]> {
      const url = listUrl(feed);
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await ensureAuthenticated(url);
      const bodies = await collectAura(url);
      if (await isLoginPage()) throw new AuthFailedError(`mymrc: logged out during ${feed} list`);
      const ids = extractListRecordIds(bodies, feed);
      log('info', `mymrc: ${feed} list → ${ids.length} record ids`);
      // Persist fresh session best-effort.
      await context.storageState({ path: stateFile }).catch(() => undefined);
      return ids;
    },

    async fetchRecordDetail(feed: FeedName, recordId: string): Promise<SfRecord> {
      const url = detailUrl(recordId);
      const bodies = await collectAura(url);
      if (await isLoginPage()) {
        throw new AuthFailedError(`mymrc: logged out during ${feed} detail ${recordId}`);
      }
      return extractRecord(bodies, recordId);
    },

    async close(): Promise<void> {
      await context.storageState({ path: stateFile }).catch(() => undefined);
      await context.close().catch(() => undefined);
    },
  };
}

async function login(page: Page, creds: SiteCredentials, log: Logger): Promise<void> {
  if (!page.url().includes('/login')) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.locator(SELECTORS.loginEmailField).first().fill(creds.username);
  await page.locator(SELECTORS.loginPasswordField).first().fill(creds.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
    page.locator(SELECTORS.loginSubmitButton).first().click(),
  ]);
  await page.waitForTimeout(3_000);
  log('info', `mymrc: login submitted (${creds.site})`);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
