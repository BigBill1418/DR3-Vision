// ADR-0111 — the auth verdict must survive Aura hydration.
//
// THE LIVE DEFECT (2026-08-18, DR3 Woodland): `dr3-vision-mymrc-scrape` paged
// with "mymrc: still logged out after fresh login (admin)" while the credential,
// the login flow and the portal were all healthy. The probe was wrong, not the
// session. `/s/` is a Salesforce Aura SPA whose authenticated marker
// ("Switch Account" / "viewing as DR3") is painted client-side AFTER
// `domcontentloaded`; the verify read the DOM at `domcontentloaded` and saw a
// bare loading shell, which `looksLoggedOut` — by its "no marker ⇒ logged out"
// fall-through — reported as logged out.
//
// Measured live the same day, re-using ONE authenticated session across 12
// trials: the `domcontentloaded` read said "logged out" in 3 of 12 (25%), while
// the settled read said "logged in" in 12 of 12.
//
// These tests pin the fix: an UNDECIDED page is waited on, a DECISIVE login page
// still fails fast, and a page that never resolves still fails LOUD.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rmMock, mkdirMock } = vi.hoisted(() => ({
  rmMock: vi.fn<(...a: unknown[]) => Promise<void>>(async () => undefined),
  mkdirMock: vi.fn<(...a: unknown[]) => Promise<void>>(async () => undefined),
}));
let stateFileExists = false;

vi.mock('node:fs/promises', () => ({ rm: rmMock, mkdir: mkdirMock }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => stateFileExists };
});

import {
  AuthFailedError,
  createPortalClient,
  looksDefinitelyLoggedOut,
  looksLoggedOut,
} from './portal-client';
import type { Browser } from 'playwright';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const AUTHED_HTML = fixture('authed-shell.html');
const LOGIN_FORM_HTML = fixture('login-form-page.html');
const UNHYDRATED_HTML = fixture('aura-unhydrated-shell.html');
const STATE_PATH = '/tmp/dr3-hydration-test/auth.json';
const CREDS = { username: 'admin@example.test', password: 'pw' };
const AUTHED_URL = 'https://mrc-us.my.site.com/s/';

// ── The pure predicates ──────────────────────────────────────────────────────

describe('aura-unhydrated-shell fixture integrity', () => {
  // The predicates scan the WHOLE document text, comments included. The first
  // draft of this fixture described the login markup in its header comment and
  // thereby asserted the exact opposite of its purpose. Pin that shut: the
  // fixture must contain no login token anywhere, in markup OR prose.
  it.each([
    ['/s/login', /\/s\/login/i],
    ['placeholder="Username"', /placeholder="Username"/i],
    ['type="password"', /type="password"/i],
    ['log in', /log\s*in/i],
    ['Switch Account', /switch account/i],
    ['viewing as DR3', /viewing as\s+dr3/i],
  ])('contains no %s token', (_label, re) => {
    expect(re.test(UNHYDRATED_HTML)).toBe(false);
  });
});

describe('looksDefinitelyLoggedOut — decisive evidence only', () => {
  const at = (html: string, url = AUTHED_URL): Parameters<typeof looksLoggedOut>[0] => ({
    url,
    html,
    usernameFieldVisible: false,
  });

  it('does NOT fire on the unhydrated Aura shell — that page is UNDECIDED', () => {
    // The bug in one assertion: `looksLoggedOut` says "logged out" here, but
    // there is no actual evidence of being logged out. Only the marker is
    // missing, and the marker has not rendered yet.
    expect(looksLoggedOut(at(UNHYDRATED_HTML))).toBe(true);
    expect(looksDefinitelyLoggedOut(at(UNHYDRATED_HTML))).toBe(false);
  });

  it('fires on a real login form', () => {
    expect(looksDefinitelyLoggedOut(at(LOGIN_FORM_HTML))).toBe(true);
  });

  it('fires on the /s/login URL regardless of body', () => {
    expect(
      looksDefinitelyLoggedOut(at(UNHYDRATED_HTML, 'https://mrc-us.my.site.com/s/login/')),
    ).toBe(true);
  });

  it('fires when the username field is visible', () => {
    expect(
      looksDefinitelyLoggedOut({ url: AUTHED_URL, html: '', usernameFieldVisible: true }),
    ).toBe(true);
  });

  it('does not fire on a fully hydrated authenticated page', () => {
    expect(looksDefinitelyLoggedOut(at(AUTHED_HTML))).toBe(false);
    expect(looksLoggedOut(at(AUTHED_HTML))).toBe(false);
  });
});

// ── Fake Playwright surface ──────────────────────────────────────────────────
//
// `htmlSequence` is what successive `page.content()` reads return once the page
// is authenticated — this is how "hydration takes a few reads" is expressed.

interface Scenario {
  /** Reads returned while authenticated, in order; the LAST value repeats. */
  authedReads: string[];
  loginSucceeds: boolean;
  seededStateValid?: boolean;
  /**
   * What an UNAUTHENTICATED `/s/` renders. Live, MyMRC serves the same
   * markerless Aura shell it serves an authenticated user (verified 2026-08-18)
   * — which is why an expired session is UNDECIDED rather than decisive. Set
   * true to model a portal that instead redirects to a real sign-in form.
   */
  anonRendersLoginForm?: boolean;
}

interface Harness {
  browser: Browser;
  loginClicks: number;
  contentReads: number;
  waits: number[];
}

function makeBrowser(scn: Scenario): Harness {
  const h: Harness = {
    browser: null as unknown as Browser,
    loginClicks: 0,
    contentReads: 0,
    waits: [],
  };

  const newContext = async (opts: { storageState?: string } = {}): Promise<unknown> => {
    const seeded = opts.storageState !== undefined;
    let loggedIn = seeded && (scn.seededStateValid ?? false);
    let url = 'about:blank';
    let readsSinceAuthed = 0;

    const page = {
      async goto(to: string): Promise<void> {
        url = to;
        readsSinceAuthed = 0; // a fresh navigation re-starts hydration
      },
      url: () => url,
      async content(): Promise<string> {
        h.contentReads += 1;
        if (url.includes('/login')) return LOGIN_FORM_HTML;
        // Live, anonymous `/s/` renders the SAME markerless shell as an authed
        // one — the shell is not evidence of being signed out.
        if (!loggedIn) return scn.anonRendersLoginForm ? LOGIN_FORM_HTML : UNHYDRATED_HTML;
        const seq = scn.authedReads;
        const html = seq[Math.min(readsSinceAuthed, seq.length - 1)] ?? AUTHED_HTML;
        readsSinceAuthed += 1;
        return html;
      },
      locator: () => ({ first: () => ({ isVisible: async (): Promise<boolean> => false }) }),
      getByPlaceholder: () => ({ first: () => ({ fill: async (): Promise<void> => undefined }) }),
      getByRole: () => ({
        first: () => ({
          click: async (): Promise<void> => {
            h.loginClicks += 1;
            if (scn.loginSucceeds) loggedIn = true;
          },
        }),
      }),
      async waitForLoadState(): Promise<void> {
        return undefined;
      },
      async waitForTimeout(ms: number): Promise<void> {
        h.waits.push(ms);
      },
      on: () => undefined,
      off: () => undefined,
    };

    return {
      setDefaultNavigationTimeout: () => undefined,
      setDefaultTimeout: () => undefined,
      newPage: async () => page,
      storageState: async (): Promise<void> => undefined,
      close: async (): Promise<void> => undefined,
    };
  };

  h.browser = { newContext } as unknown as Browser;
  return h;
}

beforeEach(() => {
  rmMock.mockClear();
  mkdirMock.mockClear();
  stateFileExists = false;
});

// ── End-to-end ───────────────────────────────────────────────────────────────

describe('openAdminSession — Aura hydration race (ADR-0111)', () => {
  it('does NOT fail a healthy login just because the marker has not rendered yet', async () => {
    // THE REGRESSION TEST. Three reads return the unhydrated shell — exactly the
    // live 3-of-12 case — before the banner lands. Pre-fix this threw
    // AuthFailedError("still logged out after fresh login"); post-fix it waits.
    const h = makeBrowser({
      loginSucceeds: true,
      authedReads: [UNHYDRATED_HTML, UNHYDRATED_HTML, UNHYDRATED_HTML, AUTHED_HTML],
    });

    const client = await createPortalClient(h.browser, CREDS, {
      storageStatePath: STATE_PATH,
      navRetries: 0,
      authSettleMs: 2_000,
      authPollMs: 250,
    });

    expect(h.loginClicks).toBe(1); // ONE login — the retry is polling, not re-logging-in
    expect(rmMock).not.toHaveBeenCalled(); // healthy session: state never purged
    await client.close();
  });

  it('still fails LOUD when the portal genuinely keeps showing a login form', async () => {
    const h = makeBrowser({ loginSucceeds: false, authedReads: [AUTHED_HTML] });

    await expect(
      createPortalClient(h.browser, CREDS, {
        storageStatePath: STATE_PATH,
        navRetries: 0,
        authSettleMs: 1_000,
        authPollMs: 250,
      }),
    ).rejects.toBeInstanceOf(AuthFailedError);
    expect(rmMock).toHaveBeenCalled(); // poisoned state purged (money-safe path intact)
  });

  it('fails fast on decisive logged-out evidence instead of burning the settle budget', async () => {
    // When the portal actually SHOWS a sign-in form, the verdict is decisive and
    // must not poll. At a 30 s budget / 250 ms that would be 120 reads per
    // verdict; decisive evidence ends each verdict on its first read.
    const h = makeBrowser({
      loginSucceeds: false,
      authedReads: [AUTHED_HTML],
      anonRendersLoginForm: true,
    });

    await expect(
      createPortalClient(h.browser, CREDS, {
        storageStatePath: STATE_PATH,
        navRetries: 0,
        authSettleMs: 30_000,
        authPollMs: 250,
      }),
    ).rejects.toBeInstanceOf(AuthFailedError);

    // Generous ceiling: a handful of verdicts, each decided on its first read.
    expect(h.contentReads).toBeLessThan(20);
  });

  it('spends the settle budget when an expired session renders the markerless shell', async () => {
    // The HONEST cost of the fix on the live portal: MyMRC serves an expired
    // session the same markerless shell it serves a live one, so that page is
    // UNDECIDED and the verdict must wait it out before failing. This is paid
    // ONLY on the failure path, once per verdict, and it is the price of not
    // killing healthy sessions. Pinned so the cost is visible if the budget is
    // ever raised.
    const h = makeBrowser({ loginSucceeds: false, authedReads: [AUTHED_HTML] });

    await expect(
      createPortalClient(h.browser, CREDS, {
        storageStatePath: STATE_PATH,
        navRetries: 0,
        authSettleMs: 1_000,
        authPollMs: 250,
      }),
    ).rejects.toBeInstanceOf(AuthFailedError);

    // 2 verdicts (pre-check + post-login) x ceil(1000/250) polls = 8 reads.
    expect(h.contentReads).toBe(8);
    // Every wait is the poll interval — no unbounded or wall-clock sleep.
    expect(h.waits.filter((w) => w === 250).length).toBeGreaterThanOrEqual(6);
  });

  it('gives up after the settle budget when the page never resolves either way', async () => {
    // The shell renders forever (portal wedged mid-hydration). Undecided must
    // still end in a LOUD failure — never an unbounded wait.
    const h = makeBrowser({ loginSucceeds: true, authedReads: [UNHYDRATED_HTML] });

    await expect(
      createPortalClient(h.browser, CREDS, {
        storageStatePath: STATE_PATH,
        navRetries: 0,
        authSettleMs: 1_000,
        authPollMs: 250,
      }),
    ).rejects.toBeInstanceOf(AuthFailedError);
  });
});
