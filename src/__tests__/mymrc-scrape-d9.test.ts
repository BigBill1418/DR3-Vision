// ADR-0057 D9 — auth-transition orchestration regression for the mymrc-scrape
// worker. The historical failure mode was: missing credentials → "skip + exit 0"
// (silent zero pulls for months). This asserts the NEW posture:
//   - unconfigured store  → FAIL LOUD: ntfy page + NON-ZERO exit, and NO fallback
//     (no browser launch, no login, no sync attempt).
//   - undecryptable creds → also fail loud (distinct exit code).
//   - configured store    → single admin login, then per-site sync runs.
//
// Collaborators are injected into `runMymrcScrape`, so this exercises the real
// control flow without a database, `dist/`, or a browser.

import { describe, expect, it, vi } from 'vitest';
import { runMymrcScrape, resolveActiveSites } from '../../scripts/mymrc-scrape.mjs';
import { CredentialsNotConfiguredError } from '@/lib/mymrc';

const KNOWN = ['eugene', 'woodland'];

type PageCall = { kind: string; site: string; message: string; fingerprint: string };

function harness(over: Record<string, unknown> = {}) {
  const pageCalls: PageCall[] = [];
  const portalArgs: unknown[][] = [];
  // The batched detail transport is built over the list client's shared session
  // (ADR-0057 D3 addendum) — the fake client exposes getSession() for that.
  const fakeSession = {};
  const fakeClient = { close: vi.fn(async () => undefined), getSession: vi.fn(() => fakeSession) };
  const fakeBrowser = { close: vi.fn(async () => undefined) };
  const launchBrowser = vi.fn(async () => fakeBrowser);
  const createPortalClient = vi.fn(async (...args: unknown[]) => {
    portalArgs.push(args);
    return fakeClient;
  });
  const playwrightRecordFieldsSession = vi.fn(() => ({}));
  const createRecordFieldsClient = vi.fn(() => ({ fetchRecordFields: vi.fn() }));
  const syncSite = vi.fn(async ({ site }: { site: string }) => [
    { feed: 'hauls', status: 'ok', rowsListed: 3, detailsFetched: 1, site },
  ]);
  const checkDeadman = vi.fn<(a: { sites: string[] }) => Promise<undefined>>(async () => undefined);
  const mymrc = {
    CredentialsNotConfiguredError,
    loadAdminCredentials: vi.fn(async () => ({ username: 'bill@svdp.us', password: 'pw' })),
    createPortalClient,
    playwrightRecordFieldsSession,
    createRecordFieldsClient,
    syncSite,
    checkDeadman,
    SITE_CODES: ['eugene', 'woodland'],
    ntfyPager: { page: async (a: PageCall): Promise<void> => void pageCalls.push(a) },
    ...over,
  };
  return {
    run: (opts = {}) => runMymrcScrape({ mymrc, prisma: {}, launchBrowser, log: () => undefined, ...opts }),
    pageCalls,
    portalArgs,
    launchBrowser,
    createPortalClient,
    syncSite,
    checkDeadman,
    fakeClient,
    fakeBrowser,
  };
}

describe('resolveActiveSites — active recycler context (deadman false-green guard, C-21)', () => {
  it('defaults to the pilot single context (woodland) when nothing is set', () => {
    expect(resolveActiveSites({ known: KNOWN, log: () => undefined })).toEqual(['woodland']);
  });

  it('parses a MYMRC_ACTIVE_SITES comma list, normalizing case/whitespace', () => {
    expect(
      resolveActiveSites({ envValue: ' Woodland , Eugene ', known: KNOWN, log: () => undefined }),
    ).toEqual(['woodland', 'eugene']);
  });

  it('drops unknown tokens and warns, keeping the valid ones', () => {
    const warn = vi.fn();
    const out = resolveActiveSites({ envValue: 'woodland,mars', known: KNOWN, log: warn });
    expect(out).toEqual(['woodland']);
    expect(warn).toHaveBeenCalledWith('warn', expect.stringContaining('mars'));
  });

  it('falls back to the pilot default (never syncs nothing) when no valid token resolves', () => {
    expect(resolveActiveSites({ envValue: 'atlantis', known: KNOWN, log: () => undefined })).toEqual([
      'woodland',
    ]);
  });

  it('an explicit list overrides the env value', () => {
    expect(
      resolveActiveSites({ explicit: ['eugene'], envValue: 'woodland', known: KNOWN, log: () => undefined }),
    ).toEqual(['eugene']);
  });
});

describe('runMymrcScrape — D9 fail-loud on missing credentials', () => {
  it('pages, exits non-zero (3), and never launches a browser or syncs', async () => {
    const h = harness({
      loadAdminCredentials: vi.fn(async () => {
        throw new CredentialsNotConfiguredError('not configured — enter at /admin/mrc-scrape');
      }),
    });

    const code = await h.run();

    expect(code).toBe(3);
    // Fail loud: exactly one page, actionable, to the creds-not-configured fingerprint.
    expect(h.pageCalls).toHaveLength(1);
    expect(h.pageCalls[0]?.fingerprint).toBe('mymrc-creds-not-configured');
    expect(h.pageCalls[0]?.message).toMatch(/\/admin\/mrc-scrape/);
    // No fallback: no browser, no login, no sync — the run stops at the gate.
    expect(h.launchBrowser).not.toHaveBeenCalled();
    expect(h.createPortalClient).not.toHaveBeenCalled();
    expect(h.syncSite).not.toHaveBeenCalled();
  });
});

describe('runMymrcScrape — D9 fail-loud on undecryptable credentials', () => {
  it('pages the load-failed fingerprint and exits 4 without launching a browser', async () => {
    const h = harness({
      loadAdminCredentials: vi.fn(async () => {
        throw new Error('MyMRC credential decryption failed the integrity check');
      }),
    });

    const code = await h.run();

    expect(code).toBe(4);
    expect(h.pageCalls).toHaveLength(1);
    expect(h.pageCalls[0]?.fingerprint).toBe('mymrc-creds-load-failed');
    expect(h.launchBrowser).not.toHaveBeenCalled();
    expect(h.syncSite).not.toHaveBeenCalled();
  });
});

describe('runMymrcScrape — configured: single admin login, active recycler context only', () => {
  it('logs in ONCE, syncs ONLY the active context (woodland default), deadman-watches the same set, exits 0', async () => {
    const h = harness();

    // No MYMRC_ACTIVE_SITES override → the pilot default (woodland only). The
    // session sees ONE recycler context; syncing the other (eugene) would write a
    // false-green sync-run that defeats its deadman (C-21).
    const code = await h.run({ activeSites: ['woodland'] });

    expect(code).toBe(0);
    // One admin login (ADR-0057 D1) — not one per site.
    expect(h.launchBrowser).toHaveBeenCalledTimes(1);
    expect(h.createPortalClient).toHaveBeenCalledTimes(1);
    // The decrypted admin credential is what gets passed to the portal client
    // (arg 1: browser, arg 2: creds).
    expect(h.portalArgs[0]?.[1]).toEqual({ username: 'bill@svdp.us', password: 'pw' });
    // ONLY the active context syncs; deadman gets that same set (no eugene false-green).
    expect(h.syncSite).toHaveBeenCalledTimes(1);
    expect(h.syncSite.mock.calls[0]?.[0]?.site).toBe('woodland');
    expect(h.checkDeadman).toHaveBeenCalledTimes(1);
    expect(h.checkDeadman.mock.calls[0]?.[0]?.sites).toEqual(['woodland']);
    expect(h.pageCalls).toHaveLength(0);
    // Resources released.
    expect(h.fakeClient.close).toHaveBeenCalledTimes(1);
    expect(h.fakeBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('MYMRC_ACTIVE_SITES-style override (explicit activeSites) syncs both contexts once Switch-Account lands', async () => {
    const h = harness();

    const code = await h.run({ activeSites: ['woodland', 'eugene'] });

    expect(code).toBe(0);
    expect(h.createPortalClient).toHaveBeenCalledTimes(1); // still ONE admin login
    expect(h.syncSite).toHaveBeenCalledTimes(2);
    expect(h.checkDeadman.mock.calls[0]?.[0]?.sites).toEqual(['woodland', 'eugene']);
  });
});

describe('runMymrcScrape — admin session fails to start', () => {
  it('pages auth_failed, exits 1, and never runs a sync', async () => {
    const h = harness({
      createPortalClient: vi.fn(async () => {
        throw new Error('login submit timed out');
      }),
    });

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.pageCalls[0]?.fingerprint).toBe('mymrc-auth-failed:admin');
    expect(h.pageCalls[0]?.kind).toBe('auth_failed');
    expect(h.syncSite).not.toHaveBeenCalled();
    expect(h.fakeBrowser.close).toHaveBeenCalledTimes(1);
  });
});
