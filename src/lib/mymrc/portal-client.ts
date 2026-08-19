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
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { adminAuthStatePath } from './credentials';
import type { MymrcCredentials } from './credential-store';
import { listRecordIds } from './mappers';
import { AUTHED_HOME_URL, LOGIN_URL, SELECTORS } from './selectors';
import type { FeedName, GetItemsReturnValue, SfRecord } from './types';

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
  // Same page, different list view — resolved by list-view id, not by path.
  haulsCompleted: '/s/hauls',
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
export function detailUrl(recordId: string): string {
  return `${PORTAL_ORIGIN}/s/detail/${encodeURIComponent(recordId)}`;
}

export { PORTAL_ORIGIN };

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

/** The list-view slice we extract: the record ids + whether the portal windowed it. */
export interface ListViewExtract {
  ids: string[];
  /**
   * `true` when the getItems returnValue reported `hasMoreData` — the id set is a
   * PARTIAL page. There is no absolute total in the Aura payload (verified against
   * the captured fixtures), so this boolean is the only completeness signal.
   */
  hasMoreData: boolean;
}

/**
 * Find the first getItems returnValue across intercepted Aura bodies and return
 * its record ids PLUS the completeness signal. Throws PortalContractDriftError when
 * no such action is present, or when it is an error list view (D4 — never a silent
 * empty list).
 */
export function extractListView(bodies: readonly string[], feed: FeedName): ListViewExtract {
  for (const body of bodies) {
    for (const action of parseAuraActions(body)) {
      if (action.state === 'SUCCESS' && isGetItemsReturnValue(action.returnValue)) {
        const rv = action.returnValue;
        if (rv.isErrorListView === true) {
          throw new PortalContractDriftError(`${feed}: list view reported isErrorListView=true`);
        }
        return { ids: listRecordIds(rv), hasMoreData: rv.hasMoreData === true };
      }
    }
  }
  throw new PortalContractDriftError(
    `${feed}: no ListViewDataManager getItems action found in ${bodies.length} Aura response(s)`,
  );
}

/**
 * Back-compat convenience: just the record ids from {@link extractListView}.
 * (`hasMoreData` is surfaced by the transport as a warn — see fetchListRecordIds.)
 */
export function extractListRecordIds(bodies: readonly string[], feed: FeedName): string[] {
  return extractListView(bodies, feed).ids;
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

// The recycler object links that only appear in the AUTHENTICATED Experience
// Cloud nav (ADR-0057 §Consequences first-contact). Two+ of these present is a
// positive logged-in marker no anonymous/404 page carries.
const AUTHED_NAV_LINKS: readonly string[] = [
  '/s/hauls',
  '/s/processed-materials',
  '/s/outbound-materials',
  '/s/availability',
  '/s/outbound-vendors',
  '/s/records-review',
  '/s/illegal-dump-cip-',
];

/** A visible login form OR a "Log in" link/button pointing at `/s/login`. */
function hasVisibleLoginControl(html: string): boolean {
  if (/placeholder="Username"/i.test(html) && /type="password"/i.test(html)) return true;
  if (/\/s\/login/i.test(html) && /log\s*in/i.test(html)) return true;
  return false;
}

/**
 * Positive authenticated marker: the "Switch Account" / "viewing as DR3" banner,
 * or ≥2 of the object nav links. `/s/home` (title "Error", no nav) carries none.
 */
function hasAuthenticatedMarker(html: string): boolean {
  if (/switch account/i.test(html)) return true;
  if (/viewing as\s+dr3/i.test(html)) return true;
  return AUTHED_NAV_LINKS.filter((href) => html.includes(href)).length >= 2;
}

/**
 * Pure logged-out predicate (ADR-0038 D4, HARDENED 2026-07-22 for ADR-0057
 * Phase 0). The old check keyed only on a password field / a "404 Error" title,
 * so the REAL `/s/home` page — a 404 "Error" shell that renders for
 * authenticated AND anonymous sessions alike, with NO password field — slipped
 * through as "logged in" (false positive: AuthFailedError never fired on a
 * genuinely failed login). This is now a POSITIVE test: a session is logged-IN
 * only when an authenticated marker is present (Switch-Account banner or the
 * object nav) AND no visible "Log in" control remains. Anything else — the login
 * form, the `/s/login` URL, a bare 404 shell, an unrecognized page — is treated
 * as logged OUT so the loud AuthFailedError path actually fires.
 */
export function looksLoggedOut(input: {
  url: string;
  html: string;
  usernameFieldVisible: boolean;
}): boolean {
  if (input.usernameFieldVisible) return true;
  if (/\/s\/login(\/|\?|$)/i.test(input.url)) return true;
  const html = input.html;
  if (hasVisibleLoginControl(html)) return true;
  // Logged in ONLY with a positive marker and no login control (checked above).
  if (hasAuthenticatedMarker(html)) return false;
  // No auth marker (e.g. the /s/home 404 "Error" shell) ⇒ NOT authenticated.
  return true;
}

/**
 * POSITIVE logged-out evidence — the DECISIVE half of `looksLoggedOut` (ADR-0111).
 *
 * `looksLoggedOut` is correct as a verdict on a FULLY RENDERED page, but it
 * reaches that verdict two different ways: a real login form (decisive) or the
 * mere ABSENCE of an authenticated marker (a fall-through assumption). On the
 * Salesforce Aura SPA at `/s/` those are not the same thing. At
 * `domcontentloaded` the shell carries NEITHER the login form NOR the
 * "Switch Account" / "viewing as DR3" banner — the banner is rendered
 * client-side moments later — so the fall-through fires on a perfectly healthy
 * session.
 *
 * This predicate reports ONLY the decisive evidence, so a caller can tell
 * "the portal is showing me a login form" (stop now) apart from
 * "nothing has rendered yet" (wait and look again).
 */
export function looksDefinitelyLoggedOut(input: {
  url: string;
  html: string;
  usernameFieldVisible: boolean;
}): boolean {
  if (input.usernameFieldVisible) return true;
  if (/\/s\/login(\/|\?|$)/i.test(input.url)) return true;
  return hasVisibleLoginControl(input.html);
}

// ── Stale-session self-heal (pure planner; unit-tested) ──────────────────────

/**
 * The next step the session bootstrap takes. Encodes the ADR-0057 self-heal
 * contract: a poisoned/stale persisted `storageState` (a prior tick that ended
 * logged-out and wrote its anonymous cookies over the good file — the live bug
 * this fixes) must be DISCARDED and re-logged-in; a login that still fails must
 * PURGE the file so the next tick starts clean and then fail LOUD.
 */
export type SessionStep =
  | 'return-authenticated' // session is logged in — proceed (and persist if fresh)
  | 'discard-and-relogin' // loaded state is logged-out — drop it, fresh login
  | 'purge-state-and-fail'; // relogin still logged-out — delete file + AuthFailedError

/**
 * Decide the next self-heal step. PURE (no Playwright/fs) so the money-safe
 * invariants are unit-tested directly:
 *   - authed after loading persisted state      ⇒ return-authenticated
 *   - not authed, relogin not yet attempted     ⇒ discard-and-relogin
 *   - not authed, relogin succeeded             ⇒ return-authenticated
 *   - not authed, relogin failed                ⇒ purge-state-and-fail
 * A logged-out session NEVER maps to a state-persisting step.
 */
export function planSessionStep(input: {
  authedAfterLoad: boolean;
  /** `null` when a fresh login has not been attempted yet. */
  authedAfterRelogin: boolean | null;
}): SessionStep {
  if (input.authedAfterLoad) return 'return-authenticated';
  if (input.authedAfterRelogin === null) return 'discard-and-relogin';
  return input.authedAfterRelogin ? 'return-authenticated' : 'purge-state-and-fail';
}

/**
 * Money-safe persistence gate: a `storageState` snapshot may be written back
 * ONLY when the session has been positively confirmed authenticated this run.
 * This is what stops `close()` from overwriting a good file with a logged-out
 * session at the end of a failed tick (recon B §8).
 */
export function mayPersistState(lastKnownAuthenticated: boolean): boolean {
  return lastKnownAuthenticated === true;
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
  /**
   * Bounded retries for a transient navigation failure (network blip, slow LDS
   * bootstrap). Total attempts = 1 + retries. Bounded on purpose — an unbounded
   * retry would risk a lockout / a tick that never returns. Default 2 retries.
   */
  navRetries?: number;
  /**
   * Bounded attempts for a MID-RUN re-authentication (the portal drops the admin
   * session mid-tick — the live alternating `ok`/`auth_failed` this fix targets).
   * Each attempt tears the now-DIRTY context down and rebuilds a CLEAN one — the
   * SAME recovery `bootstrap` uses for a poisoned persisted state — because a
   * same-page relogin on a half-torn context is unreliable. Bounded on purpose:
   * a persistently logged-out portal must fail LOUD (AuthFailedError + purge),
   * never spin forever risking a lockout. Total attempts = this value. Default 3.
   */
  reauthAttempts?: number;
  /** Short backoff between mid-run re-auth attempts, ms — absorbs transient
   * `net::ERR_ABORTED` nav flakiness before the next clean rebuild. Default 800. */
  reauthBackoffMs?: number;
  /**
   * How long the auth verdict may wait for the Aura shell to render its
   * authenticated marker before giving up and reporting logged-out (ADR-0111).
   * Only ever spent when the page is UNDECIDED — a real login form short-circuits
   * on the first read, so an expired session still fails fast. Default 15000.
   */
  authSettleMs?: number;
  /** Poll interval while the auth verdict is undecided, ms. Default 250. */
  authPollMs?: number;
  log?: Logger;
}

const DEFAULT_NAV_RETRIES = 2;
const DEFAULT_REAUTH_ATTEMPTS = 3;
const DEFAULT_REAUTH_BACKOFF_MS = 800;
/**
 * ADR-0111. Aura hydration of `/s/` was observed at ~2.6–4.5 s to
 * `domcontentloaded` with the authenticated banner landing after that; 15 s
 * leaves generous headroom over the slowest observed render while still
 * bounding a genuinely dead session to one tick.
 */
const DEFAULT_AUTH_SETTLE_MS = 15_000;
const DEFAULT_AUTH_POLL_MS = 250;

/**
 * A list fetch result: the window's record ids PLUS whether that window is the
 * COMPLETE active set. `complete=false` means the portal reported
 * `hasMoreData:true` — only the first Aura window was returned, so the ids are a
 * PARTIAL page. The sync engine MUST NOT run disappeared-detection against a
 * partial page (it would mass-mark the unseen tail as disappeared and drop those
 * rows from billing) — this flag is the guard that makes that impossible.
 */
export interface ListRecordIdsResult {
  ids: string[];
  complete: boolean;
}

/**
 * The transport contract the sync engine depends on. Kept minimal so tests can
 * substitute a fake and never touch Playwright.
 */
export interface PortalClient {
  fetchListRecordIds(feed: FeedName): Promise<ListRecordIdsResult>;
  /**
   * The underlying proven-authenticated admin session. Exposed so the batched
   * detail transport (record-fields-client) can be built over the SAME session
   * (one admin login serves both list + detail) without this module importing
   * record-fields-client (avoids a transport import cycle).
   */
  getSession(): AdminSession;
  close(): Promise<void>;
}

/**
 * A PROVEN-AUTHENTICATED admin browser session with the self-heal + Aura
 * plumbing every MyMRC transport shares. Both the steady-state `PortalClient`
 * (interception transport) and the backfill offset transport build on ONE of
 * these — so auth, the stale-session self-heal, and the money-safe persistence
 * latch live in exactly one place (ADR-0057 Phase 1). `getPage()`/`getContext()`
 * return the LIVE page/context (the self-heal rebuilds the context, so callers
 * must never cache the reference across an `ensureAuthenticated`).
 */
export interface AdminSession {
  getPage(): Page;
  getContext(): BrowserContext;
  /** Bounded-retry navigation; never throws (a dead nav reads as logged-out). */
  gotoWithRetry(url: string, waitUntil: 'domcontentloaded' | 'networkidle'): Promise<void>;
  /** Re-login in place if the session dropped; purge + throw AuthFailedError if it stays out. */
  ensureAuthenticated(targetUrl: string): Promise<void>;
  /** `true` when the current page looks logged-out (positive-marker test, D4). */
  isLoginPage(): Promise<boolean>;
  /** Navigate + collect every intercepted `/s/sfsites/aura` RESPONSE body during load+settle. */
  collectAura(url: string): Promise<string[]>;
  /** Delete the poisoned storageState so the next tick boots clean (best-effort). */
  purgeState(): Promise<void>;
  /** Persist the session snapshot ONLY when positively authenticated this run. */
  persistIfAuthenticated(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Open a proven-authenticated admin session (reusing persisted storage state
 * when present). Caller owns the `Browser`.
 *
 * STALE-SESSION SELF-HEAL (ADR-0057 Phase 1, recon B §8). The live failure this
 * closes: a tick that ended logged-out wrote its anonymous cookies over the
 * good `storageState` file (the old `close()` persisted UNCONDITIONALLY), so the
 * NEXT tick booted from a poisoned state and stayed broken until an operator
 * cleared the file. The contract is now:
 *   - Bootstrap PROVES auth up front by navigating to the authed home.
 *   - If the loaded state is logged-out, DISCARD it (rebuild the context with no
 *     seed) and do a FRESH login.
 *   - If login still fails, DELETE the poisoned file so the next tick starts
 *     clean, then throw `AuthFailedError` (D5 — the scrape worker pages).
 *   - A `storageState` is persisted ONLY after a positive auth check — never on
 *     `close()` when the session is known logged-out, never on a failed login.
 * Bounded nav retries absorb a transient blip without an unbounded loop.
 */
export async function openAdminSession(
  browser: Browser,
  creds: MymrcCredentials,
  opts: PortalClientOptions = {},
): Promise<AdminSession> {
  const log = opts.log ?? noopLog;
  const navTimeout = opts.navTimeoutMs ?? NAV_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const navRetries = Math.max(0, opts.navRetries ?? DEFAULT_NAV_RETRIES);
  const reauthAttempts = Math.max(1, opts.reauthAttempts ?? DEFAULT_REAUTH_ATTEMPTS);
  const reauthBackoffMs = Math.max(0, opts.reauthBackoffMs ?? DEFAULT_REAUTH_BACKOFF_MS);
  const authSettleMs = Math.max(0, opts.authSettleMs ?? DEFAULT_AUTH_SETTLE_MS);
  const authPollMs = Math.max(1, opts.authPollMs ?? DEFAULT_AUTH_POLL_MS);
  const stateFile = opts.storageStatePath ?? adminAuthStatePath();
  await mkdir(dirname(stateFile), { recursive: true });

  // `context`/`page` are reassignable: the self-heal rebuilds the context WITHOUT
  // the persisted seed to guarantee a clean login when the loaded state is bad.
  let context: BrowserContext = await newSessionContext(true);
  let page: Page = await context.newPage();
  // Money-safe latch: no `storageState` write happens unless this is true.
  let lastKnownAuthenticated = false;

  async function newSessionContext(seedFromFile: boolean): Promise<BrowserContext> {
    const ctx = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 900 },
      ...(seedFromFile && existsSync(stateFile) ? { storageState: stateFile } : {}),
    });
    ctx.setDefaultNavigationTimeout(navTimeout);
    ctx.setDefaultTimeout(navTimeout);
    return ctx;
  }

  async function usernameVisible(): Promise<boolean> {
    return page
      .locator(SELECTORS.loginRedirectMarker)
      .first()
      .isVisible()
      .catch(() => false);
  }

  /**
   * The auth verdict, tolerant of Aura hydration (ADR-0111).
   *
   * A SINGLE read at `domcontentloaded` mis-reported a healthy admin session as
   * logged-out in 3 of 12 live trials on 2026-08-18 — trials in which the
   * session was authenticated 12 of 12 times once the page had settled. That
   * 25% false-negative rate is what produced the intermittent
   * "still logged out after fresh login" page: the credential, the login flow
   * and the portal were all fine; only the probe was wrong.
   *
   * So this polls until the page is DECIDED:
   *   - an authenticated marker appears        ⇒ logged IN  (returns false)
   *   - decisive logged-out evidence appears   ⇒ logged OUT (returns true, fast —
   *                                               a genuinely expired session
   *                                               still fails on the first read)
   *   - neither, all the way to the deadline   ⇒ logged OUT (fail LOUD, unchanged)
   *
   * The deadline is a POLL COUNT, not wall-clock, so the bound is deterministic
   * under a fake clock in tests.
   */
  async function isLoginPage(): Promise<boolean> {
    const polls = Math.max(1, Math.ceil(authSettleMs / authPollMs));
    for (let attempt = 1; ; attempt++) {
      const input = {
        url: page.url(),
        html: await page.content().catch(() => ''),
        usernameFieldVisible: await usernameVisible(),
      };
      if (!looksLoggedOut(input)) return false;
      if (looksDefinitelyLoggedOut(input)) return true;
      if (attempt >= polls) {
        log(
          'warn',
          `mymrc: auth state still undecided after ${attempt} poll(s) (~${authSettleMs}ms) — treating as logged out`,
        );
        return true;
      }
      await page.waitForTimeout(authPollMs).catch(() => undefined);
    }
  }

  // Bounded-retry navigation. Never throws — a nav that never resolves leaves the
  // page on its prior/blank URL, which `isLoginPage()` reads as logged-out, so
  // the auth/self-heal path (not an unhandled throw) decides what happens next.
  async function gotoWithRetry(
    url: string,
    waitUntil: 'domcontentloaded' | 'networkidle',
  ): Promise<void> {
    for (let attempt = 0; attempt <= navRetries; attempt++) {
      try {
        await page.goto(url, { waitUntil });
        return;
      } catch (e: unknown) {
        log(
          'warn',
          `mymrc: goto ${url} attempt ${attempt + 1}/${navRetries + 1} — ${describeError(e)}`,
        );
      }
    }
  }

  async function purgeState(): Promise<void> {
    lastKnownAuthenticated = false;
    await rm(stateFile, { force: true }).catch(() => undefined);
  }

  async function persistIfAuthenticated(): Promise<void> {
    if (!mayPersistState(lastKnownAuthenticated)) return;
    await context.storageState({ path: stateFile }).catch(() => undefined);
  }

  // The ONE clean-recovery primitive shared by bootstrap (poisoned persisted
  // state) and ensureAuthenticated (mid-run drop). A logged-out state — whether
  // loaded from disk or induced mid-run by the flaky portal — leaves the context
  // DIRTY (anonymous cookies, an aborted nav, half-torn Aura listeners). A relogin
  // ON that dirty context is unreliable (the live alternating `ok`/`auth_failed`).
  // So we always: tear the context down, rebuild a FRESH one WITHOUT the persisted
  // seed, open a new page, log in, navigate to `verifyUrl`, and report whether the
  // session is now authenticated. The `context`/`page` closure vars are reassigned
  // in place, so every later `collectAura`/`fetch` call uses the HEALED page.
  async function rebuildAndLogin(verifyUrl: string): Promise<boolean> {
    await context.close().catch(() => undefined);
    context = await newSessionContext(false);
    page = await context.newPage();
    await login(page, creds, log);
    await gotoWithRetry(verifyUrl, 'domcontentloaded');
    return !(await isLoginPage());
  }

  // Prove auth up front, self-healing a poisoned/stale persisted state.
  async function bootstrap(): Promise<void> {
    await gotoWithRetry(AUTHED_HOME_URL, 'domcontentloaded');
    const authedAfterLoad = !(await isLoginPage());
    if (planSessionStep({ authedAfterLoad, authedAfterRelogin: null }) === 'return-authenticated') {
      lastKnownAuthenticated = true;
      log('info', 'mymrc: persisted admin session valid');
      return;
    }

    // Loaded state is logged-out → discard it and log in from a clean context.
    log('warn', 'mymrc: persisted session logged-out — discarding it, fresh login (admin)');
    const authedAfterRelogin = await rebuildAndLogin(AUTHED_HOME_URL);
    if (
      planSessionStep({ authedAfterLoad: false, authedAfterRelogin }) === 'purge-state-and-fail'
    ) {
      await purgeState(); // never leave the poisoned file behind, never persist
      throw new AuthFailedError('mymrc: still logged out after fresh login (admin)');
    }
    lastKnownAuthenticated = true;
    await persistIfAuthenticated();
  }

  // Mid-run re-auth. The portal drops the admin session almost every tick (the
  // live alternating `ok`/`auth_failed`). Recover the SAME way bootstrap does —
  // rebuild a CLEAN context and log in — NOT a relogin on the dirty page (which is
  // what made this flap). Bounded retries absorb the transient `net::ERR_ABORTED`
  // nav flakiness; on final failure we purge the poisoned state and fail LOUD so a
  // genuinely dead session pages (D5) rather than silently under-syncing billing.
  async function ensureAuthenticated(targetUrl: string): Promise<void> {
    if (!(await isLoginPage())) return;
    log('warn', 'mymrc: session dropped mid-run — rebuilding a clean session (admin)');
    lastKnownAuthenticated = false;
    for (let attempt = 1; attempt <= reauthAttempts; attempt++) {
      try {
        if (await rebuildAndLogin(targetUrl)) {
          lastKnownAuthenticated = true;
          log(
            'info',
            `mymrc: mid-run re-auth recovered on attempt ${attempt}/${reauthAttempts} (admin)`,
          );
          return;
        }
        log(
          'warn',
          `mymrc: mid-run re-auth attempt ${attempt}/${reauthAttempts} still logged out (admin)`,
        );
      } catch (e: unknown) {
        log(
          'warn',
          `mymrc: mid-run re-auth attempt ${attempt}/${reauthAttempts} threw — ${describeError(e)} (admin)`,
        );
      }
      if (attempt < reauthAttempts && reauthBackoffMs > 0) {
        await page.waitForTimeout(reauthBackoffMs).catch(() => undefined);
      }
    }
    await purgeState(); // never leave the poisoned file behind, never persist
    throw new AuthFailedError('mymrc: still logged out after re-auth (admin)');
  }

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
      await gotoWithRetry(url, 'networkidle');
      await page.waitForTimeout(settleMs);
    } finally {
      page.off('response', onResponse);
    }
    return bodies;
  }

  await bootstrap();

  return {
    getPage: () => page,
    getContext: () => context,
    gotoWithRetry,
    ensureAuthenticated,
    isLoginPage,
    collectAura,
    purgeState,
    persistIfAuthenticated,
    async close(): Promise<void> {
      // ONLY persist a session we positively confirmed authenticated. A tick that
      // ended logged-out must NOT overwrite the good file (recon B §8) — and if it
      // hard-failed, `purgeState()` already removed it.
      await persistIfAuthenticated();
      await context.close().catch(() => undefined);
    },
  };
}

/**
 * Log in (reusing persisted storage state when present) and return a
 * session-bound, PROVEN-AUTHENTICATED PortalClient. Caller owns the `Browser`.
 * A thin consumer of {@link openAdminSession} — all the auth/self-heal contract
 * lives there; this adds only the steady-state list/detail interception transport.
 */
export async function createPortalClient(
  browser: Browser,
  creds: MymrcCredentials,
  opts: PortalClientOptions = {},
): Promise<PortalClient> {
  const log = opts.log ?? noopLog;
  const session = await openAdminSession(browser, creds, opts);

  return {
    async fetchListRecordIds(feed: FeedName): Promise<ListRecordIdsResult> {
      const url = listUrl(feed);
      await session.gotoWithRetry(url, 'domcontentloaded');
      await session.ensureAuthenticated(url);
      const bodies = await session.collectAura(url);
      if (await session.isLoginPage()) {
        await session.purgeState();
        throw new AuthFailedError(`mymrc: logged out during ${feed} list`);
      }
      const { ids, hasMoreData } = extractListView(bodies, feed);
      // Completeness signal: the Aura payload has no absolute record total, so a
      // windowed page (`hasMoreData:true`) is the only over-mark risk we can
      // detect. We do NOT throw — windowing is a normal state for large feeds
      // (processed/outbound routinely exceed one page) — but we surface
      // `complete:false` to the caller so it can SKIP disappeared-detection (the
      // sync engine's money-safe guard), and WARN so a truncated list is
      // diagnosable. The backfill worker drains the tail into the mirror.
      if (hasMoreData) {
        log(
          'warn',
          `mymrc: ${feed} list is WINDOWED (hasMoreData=true) — ${ids.length} ids on this page; disappeared-detection is SKIPPED (never over-mark against a partial page)`,
        );
      }
      log('info', `mymrc: ${feed} list → ${ids.length} record ids (complete=${!hasMoreData})`);
      await session.persistIfAuthenticated();
      return { ids, complete: !hasMoreData };
    },

    getSession(): AdminSession {
      return session;
    },

    async close(): Promise<void> {
      await session.close();
    },
  };
}

// Proven-live login (ADR-0057 Phase 0, 2026-07-22): the Lightning form fields
// have no `name` and dynamic numeric ids, so we locate them by PLACEHOLDER and
// the submit by ROLE — the only stable hooks. `getByPlaceholder`/`getByRole`
// normalize whitespace, absorbing the trailing-whitespace padding the live form
// sometimes renders.
async function login(page: Page, creds: MymrcCredentials, log: Logger): Promise<void> {
  if (!page.url().includes('/login')) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.getByPlaceholder('Username').first().fill(creds.username);
  await page.getByPlaceholder('Password').first().fill(creds.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
    page
      .getByRole('button', { name: /log ?in/i })
      .first()
      .click(),
  ]);
  await page.waitForTimeout(3_000);
  log('info', 'mymrc: login submitted (admin)');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
