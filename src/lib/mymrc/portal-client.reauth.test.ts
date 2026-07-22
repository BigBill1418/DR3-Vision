// ADR-0057 — mid-run re-authentication hardening (2026-07-22).
//
// The live bug this covers: the MyMRC/Salesforce portal drops the admin session
// MID-RUN almost every hourly tick (the sync ledger alternates `ok`/`auth_failed`).
// The OLD `ensureAuthenticated` re-logged-in ON THE SAME, now-DIRTY context/page
// (aborted nav, half-torn Aura listeners) — unreliable: it healed sometimes, threw
// `AuthFailedError('still logged out after re-auth')` others.
//
// The fix makes a mid-run drop recover the SAME way `bootstrap` recovers a poisoned
// persisted state: tear the dirty context down, rebuild a CLEAN one WITHOUT the
// seed, log in, verify — wrapped in a BOUNDED retry, purging state + failing loud
// only after every attempt fails. These tests drive `openAdminSession` against a
// FAKE Playwright browser and assert:
//   - mid-run drop → clean-context re-auth SUCCEEDS (was failing on the dirty page),
//   - mid-run drop → re-auth recovers on a LATER attempt (bounded retry works),
//   - mid-run drop → every attempt fails → state PURGED + AuthFailedError thrown,
//     and a logged-out session is NEVER persisted.
//
// NOTE: a unit test cannot reproduce the live flaky portal's exact timing; it
// models the observable contract (drop → rebuild-clean → verify) with a fake.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { AuthFailedError, openAdminSession } from './portal-client';
import type { Browser } from 'playwright';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const AUTHED_HTML = fixture('authed-shell.html');
const LOGGED_OUT_HTML = fixture('login-form-page.html');
const STATE_PATH = '/tmp/dr3-reauth-test/auth.json';
const CREDS = { username: 'admin@example.test', password: 'pw' };
const TARGET_URL = 'https://mrc-us.my.site.com/s/hauls';

// ── Fake Playwright surface with a MID-RUN drop ──────────────────────────────
//
// `seededStateValid` → the seeded bootstrap context lands authed (so the client
// opens healthy, THEN we induce a drop). `reloginSucceedsAtAttempt` → the login
// against a REBUILT clean context succeeds once the cumulative login-click count
// reaches this value (1 = first rebuild heals; undefined = never heals).

interface Scenario {
  seededStateValid: boolean;
  reloginSucceedsAtAttempt?: number;
}

interface FakeContext {
  seeded: boolean;
  storageStateCalls: string[];
  closed: boolean;
}
interface FakePage {
  dropped: boolean;
}
interface Harness {
  browser: Browser;
  contexts: FakeContext[];
  loginClicks: number;
  activePage: FakePage;
  dropActivePage(): void;
}

function makeBrowser(scn: Scenario): Harness {
  const contexts: FakeContext[] = [];
  const h: Harness = {
    browser: null as unknown as Browser,
    contexts,
    loginClicks: 0,
    activePage: { dropped: false },
    dropActivePage(): void {
      h.activePage.dropped = true;
    },
  };

  const newContext = async (opts: { storageState?: string } = {}): Promise<unknown> => {
    const seeded = opts.storageState !== undefined;
    const ctx: FakeContext = { seeded, storageStateCalls: [], closed: false };
    contexts.push(ctx);

    // A seeded-valid context boots authed; a rebuilt one starts logged-out and is
    // flipped by a successful login click.
    let loggedIn = seeded && scn.seededStateValid;
    let url = 'about:blank';

    const makePage = (): FakePage & Record<string, unknown> => {
      const p: FakePage = { dropped: false };
      h.activePage = p;
      return {
        ...p,
        async goto(to: string): Promise<void> {
          url = to;
        },
        url: () => url,
        async content(): Promise<string> {
          if (url.includes('/login')) return LOGGED_OUT_HTML;
          // A DROPPED page reads logged-out even on an authed context — this is the
          // mid-run session loss the portal inflicts.
          return loggedIn && !p.dropped ? AUTHED_HTML : LOGGED_OUT_HTML;
        },
        locator: () => ({ first: () => ({ isVisible: async (): Promise<boolean> => false }) }),
        getByPlaceholder: () => ({ first: () => ({ fill: async (): Promise<void> => undefined }) }),
        getByRole: () => ({
          first: () => ({
            click: async (): Promise<void> => {
              h.loginClicks += 1;
              if (scn.reloginSucceedsAtAttempt !== undefined && h.loginClicks >= scn.reloginSucceedsAtAttempt) {
                loggedIn = true;
              }
            },
          }),
        }),
        async waitForLoadState(): Promise<void> {
          return undefined;
        },
        async waitForTimeout(): Promise<void> {
          return undefined;
        },
        on: () => undefined,
        off: () => undefined,
      };
    };

    return {
      setDefaultNavigationTimeout: () => undefined,
      setDefaultTimeout: () => undefined,
      newPage: async () => makePage(),
      storageState: async ({ path }: { path: string }): Promise<void> => {
        ctx.storageStateCalls.push(path);
      },
      close: async (): Promise<void> => {
        ctx.closed = true;
      },
    };
  };

  h.browser = { newContext } as unknown as Browser;
  return h;
}

beforeEach(() => {
  rmMock.mockClear();
  mkdirMock.mockClear();
  stateFileExists = true; // a valid persisted session exists at boot
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureAuthenticated — mid-run drop clean-context re-auth', () => {
  it('rebuilds a CLEAN context and heals on the first attempt (was failing on the dirty page)', async () => {
    const h = makeBrowser({ seededStateValid: true, reloginSucceedsAtAttempt: 1 });
    const session = await openAdminSession(h.browser, CREDS, {
      storageStatePath: STATE_PATH,
      navRetries: 0,
      reauthBackoffMs: 0,
    });
    expect(h.contexts).toHaveLength(1); // healthy seeded boot, no rebuild yet
    expect(h.loginClicks).toBe(0);

    h.dropActivePage(); // portal drops the session mid-run
    await session.ensureAuthenticated(TARGET_URL); // must NOT throw

    expect(h.contexts).toHaveLength(2); // dirty context torn down, clean one built
    expect(h.contexts[0]?.closed).toBe(true); // the dropped/dirty context disposed
    expect(h.contexts[1]?.seeded).toBe(false); // rebuilt WITHOUT the seed
    expect(h.loginClicks).toBe(1);
    expect(await session.isLoginPage()).toBe(false); // healed page is authed

    // Latch is set → persist writes on the HEALED (clean) context, never the old one.
    await session.persistIfAuthenticated();
    expect(h.contexts[1]?.storageStateCalls).toContain(STATE_PATH);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('recovers on a LATER attempt via the bounded retry', async () => {
    const h = makeBrowser({ seededStateValid: true, reloginSucceedsAtAttempt: 2 });
    const session = await openAdminSession(h.browser, CREDS, {
      storageStatePath: STATE_PATH,
      navRetries: 0,
      reauthAttempts: 3,
      reauthBackoffMs: 0,
    });

    h.dropActivePage();
    await session.ensureAuthenticated(TARGET_URL);

    // 1 seeded + 2 rebuilds (attempt 1 failed, attempt 2 healed).
    expect(h.contexts).toHaveLength(3);
    expect(h.loginClicks).toBe(2);
    expect(await session.isLoginPage()).toBe(false);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('PURGES state and throws AuthFailedError when every re-auth attempt fails', async () => {
    const h = makeBrowser({ seededStateValid: true }); // reloginSucceedsAtAttempt omitted → never heals
    const session = await openAdminSession(h.browser, CREDS, {
      storageStatePath: STATE_PATH,
      navRetries: 0,
      reauthAttempts: 3,
      reauthBackoffMs: 0,
    });

    h.dropActivePage();
    await expect(session.ensureAuthenticated(TARGET_URL)).rejects.toBeInstanceOf(AuthFailedError);

    // 1 seeded + 3 exhausted rebuild attempts.
    expect(h.contexts).toHaveLength(4);
    expect(h.loginClicks).toBe(3);
    // Poisoned state deleted so the next tick starts clean …
    expect(rmMock).toHaveBeenCalledWith(STATE_PATH, { force: true });
    // … and a logged-out session is NEVER written back on any context.
    for (const ctx of h.contexts) expect(ctx.storageStateCalls).toHaveLength(0);
  });
});
