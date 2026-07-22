// ADR-0057 Phase 1 — stale-session self-heal (recon B §8) end-to-end coverage.
//
// The live bug: a tick that ended logged-out wrote its anonymous cookies over
// the good `storageState`, so the NEXT tick booted poisoned and stayed broken.
// These tests drive `createPortalClient` against a FAKE Playwright browser and
// assert the money-safe invariants:
//   - a valid persisted session is reused (no needless re-login),
//   - a stale/invalid persisted state is DISCARDED (context rebuilt WITHOUT the
//     seed) and a fresh login runs,
//   - a login that still fails DELETES the poisoned state file and throws
//     AuthFailedError, and NEVER persists a logged-out session,
//   - a healthy session persists its state exactly once it is confirmed authed,
//   - a transient navigation error is absorbed by the bounded retry.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fs mocks — `vi.hoisted` so the (hoisted) `vi.mock` factory can reference them.
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

import { AuthFailedError, createPortalClient, mayPersistState, planSessionStep } from './portal-client';
import type { Browser } from 'playwright';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const AUTHED_HTML = fixture('authed-shell.html');
const LOGGED_OUT_HTML = fixture('login-form-page.html');
const STATE_PATH = '/tmp/dr3-selfheal-test/auth.json';
const CREDS = { username: 'admin@example.test', password: 'pw' };

// ── Fake Playwright surface ──────────────────────────────────────────────────
//
// A scenario drives the session outcome. `seededStateValid` = whether a context
// created WITH the persisted seed lands authenticated. `loginSucceeds` = whether
// a fresh login lands authenticated. `transientNavFailures` = number of leading
// page.goto() calls that reject before one succeeds (exercises bounded retry).

interface Scenario {
  seededStateValid: boolean;
  loginSucceeds: boolean;
  transientNavFailures?: number;
}

interface Harness {
  browser: Browser;
  contexts: FakeContext[];
  loginClicks: number;
}

interface FakeContext {
  seeded: boolean;
  storageStateCalls: string[];
  closed: boolean;
}

function makeBrowser(scn: Scenario): Harness {
  const contexts: FakeContext[] = [];
  const h: Harness = { browser: null as unknown as Browser, contexts, loginClicks: 0 };
  let navFailuresLeft = scn.transientNavFailures ?? 0;

  const newContext = async (opts: { storageState?: string } = {}): Promise<unknown> => {
    const seeded = opts.storageState !== undefined;
    const ctx: FakeContext = { seeded, storageStateCalls: [], closed: false };
    contexts.push(ctx);

    // A context is "logged in" if it was seeded from a valid state, OR a fresh
    // login has succeeded against it. Login flips this via the submit click.
    let loggedIn = seeded && scn.seededStateValid;
    let url = 'about:blank';

    const page = {
      async goto(to: string): Promise<void> {
        if (navFailuresLeft > 0) {
          navFailuresLeft -= 1;
          throw new Error('net::ERR_TIMED_OUT (transient)');
        }
        url = to;
      },
      url: () => url,
      async content(): Promise<string> {
        if (url.includes('/login')) return LOGGED_OUT_HTML;
        return loggedIn ? AUTHED_HTML : LOGGED_OUT_HTML;
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
      async waitForTimeout(): Promise<void> {
        return undefined;
      },
      on: () => undefined,
      off: () => undefined,
    };

    return {
      setDefaultNavigationTimeout: () => undefined,
      setDefaultTimeout: () => undefined,
      newPage: async () => page,
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
  stateFileExists = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Pure planner (money-safe invariants, no Playwright) ──────────────────────

describe('planSessionStep', () => {
  it('reuses a session authenticated after loading persisted state', () => {
    expect(planSessionStep({ authedAfterLoad: true, authedAfterRelogin: null })).toBe('return-authenticated');
  });
  it('discards + re-logs-in when the loaded state is logged-out', () => {
    expect(planSessionStep({ authedAfterLoad: false, authedAfterRelogin: null })).toBe('discard-and-relogin');
  });
  it('returns authenticated after a successful relogin', () => {
    expect(planSessionStep({ authedAfterLoad: false, authedAfterRelogin: true })).toBe('return-authenticated');
  });
  it('purges + fails when relogin still logged-out (never persists)', () => {
    expect(planSessionStep({ authedAfterLoad: false, authedAfterRelogin: false })).toBe('purge-state-and-fail');
  });
});

describe('mayPersistState', () => {
  it('permits a write only when positively authenticated', () => {
    expect(mayPersistState(true)).toBe(true);
    expect(mayPersistState(false)).toBe(false);
  });
});

// ── End-to-end self-heal ─────────────────────────────────────────────────────

describe('createPortalClient — stale-session self-heal', () => {
  it('reuses a VALID persisted session (no re-login, no discard)', async () => {
    stateFileExists = true;
    const h = makeBrowser({ seededStateValid: true, loginSucceeds: true });
    const client = await createPortalClient(h.browser, CREDS, { storageStatePath: STATE_PATH, navRetries: 0 });

    expect(h.contexts).toHaveLength(1); // no rebuild
    expect(h.contexts[0]?.seeded).toBe(true); // booted from the persisted state
    expect(h.loginClicks).toBe(0); // valid session never re-logs in
    await client.close();
    // close() persists the confirmed-authenticated session.
    expect(h.contexts[0]?.storageStateCalls).toContain(STATE_PATH);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('DISCARDS a stale persisted state and logs in fresh, then persists', async () => {
    stateFileExists = true;
    const h = makeBrowser({ seededStateValid: false, loginSucceeds: true });
    const client = await createPortalClient(h.browser, CREDS, { storageStatePath: STATE_PATH, navRetries: 0 });

    expect(h.contexts).toHaveLength(2); // context rebuilt after discard
    expect(h.contexts[0]?.seeded).toBe(true); // first tried the persisted seed
    expect(h.contexts[0]?.closed).toBe(true); // stale context disposed
    expect(h.contexts[1]?.seeded).toBe(false); // rebuilt WITHOUT the poisoned seed
    expect(h.loginClicks).toBeGreaterThanOrEqual(1); // fresh login ran
    // Fresh good state persisted during bootstrap (on the rebuilt context).
    expect(h.contexts[1]?.storageStateCalls).toContain(STATE_PATH);
    expect(rmMock).not.toHaveBeenCalled(); // recovered — nothing to purge
    await client.close();
  });

  it('logs in fresh when NO persisted state exists', async () => {
    stateFileExists = false;
    const h = makeBrowser({ seededStateValid: false, loginSucceeds: true });
    const client = await createPortalClient(h.browser, CREDS, { storageStatePath: STATE_PATH, navRetries: 0 });

    expect(h.contexts[0]?.seeded).toBe(false); // no file → never seeded
    expect(h.loginClicks).toBeGreaterThanOrEqual(1);
    await client.close();
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('PURGES the poisoned file and throws AuthFailedError when login still fails', async () => {
    stateFileExists = true;
    const h = makeBrowser({ seededStateValid: false, loginSucceeds: false });

    await expect(
      createPortalClient(h.browser, CREDS, { storageStatePath: STATE_PATH, navRetries: 0 }),
    ).rejects.toBeInstanceOf(AuthFailedError);

    // The poisoned state file is deleted so the next tick starts clean …
    expect(rmMock).toHaveBeenCalledWith(STATE_PATH, { force: true });
    // … and a logged-out session is NEVER written back.
    for (const ctx of h.contexts) expect(ctx.storageStateCalls).toHaveLength(0);
  });

  it('absorbs a transient navigation failure via the bounded retry', async () => {
    stateFileExists = true;
    // One leading goto rejects; the retry succeeds and the valid seed authenticates.
    const h = makeBrowser({ seededStateValid: true, loginSucceeds: true, transientNavFailures: 1 });
    const client = await createPortalClient(h.browser, CREDS, { storageStatePath: STATE_PATH, navRetries: 2 });

    expect(h.contexts).toHaveLength(1); // recovered on retry, no discard needed
    expect(h.loginClicks).toBe(0);
    await client.close();
    expect(rmMock).not.toHaveBeenCalled();
  });
});
