// ADR-0111 — session-start failures must be LEDGERED, and must not page until
// the system has been given its chance to self-heal.
//
// Two defects from the 2026-08-18 incident are pinned here:
//
//  1. INVISIBLE IN THE LEDGER. `openAdminSession` throws before any feed row is
//     written, so a tick that never got a session left no ledger trace at all.
//     `mymrc_sync_runs` read 100% green straight through the incident and the
//     only evidence lived in a container log that the next redeploy destroys.
//
//  2. PAGED TOO EAGERLY. The page fired on the FIRST failed tick, gated by a
//     cooldown Map held in the per-tick process — a process that exits after
//     every tick, so the Map was empty every time and gated nothing. A blip that
//     self-heals 9 minutes later still woke someone (ADR-0037 Q3).

import { describe, expect, it, vi } from 'vitest';
import { runMymrcScrape, recordSessionFailure } from '../../scripts/mymrc-scrape.mjs';

type PageCall = { kind: string; site: string; message: string; fingerprint: string };
type LedgerRow = {
  site_id: string;
  feed: string;
  status: string;
  error?: string;
  started_at: Date;
};

/** Prisma double holding the ledger in memory. `priorFailures` seeds the window. */
function fakePrisma(priorFailures = 0) {
  const rows: LedgerRow[] = [];
  for (let i = 0; i < priorFailures; i++) {
    rows.push({
      site_id: 'site-woodland',
      feed: '__session__',
      status: 'auth_failed',
      started_at: new Date(),
    });
  }
  return {
    rows,
    site: {
      findFirst: vi.fn<(...a: unknown[]) => Promise<{ id: string } | null>>(async () => ({
        id: 'site-woodland',
      })),
    },
    mymrcSyncRun: {
      create: vi.fn(async ({ data }: { data: LedgerRow }) => {
        rows.push(data);
        return data;
      }),
      count: vi.fn(
        async ({
          where,
        }: {
          where: { feed: string; status?: string; started_at?: { gte: Date } };
        }) =>
          rows.filter(
            (r) =>
              r.feed === where.feed &&
              (where.status === undefined || r.status === where.status) &&
              (where.started_at?.gte === undefined || r.started_at >= where.started_at.gte),
          ).length,
      ),
    },
  };
}

function harness(prisma: unknown, opts: { launchError?: Error } = {}) {
  const pageCalls: PageCall[] = [];
  const mymrc = {
    CredentialsNotConfiguredError: class extends Error {},
    loadAdminCredentials: vi.fn(async () => ({ username: 'admin@example.test', password: 'pw' })),
    // The session never starts — the incident's shape.
    createPortalClient: vi.fn(async () => {
      throw new Error('mymrc: still logged out after fresh login (admin)');
    }),
    playwrightRecordFieldsSession: vi.fn(() => ({})),
    createRecordFieldsClient: vi.fn(() => ({ fetchRecordFields: vi.fn() })),
    syncSite: vi.fn(async () => []),
    checkDeadman: vi.fn(async () => undefined),
    SITE_CODES: ['eugene', 'woodland'],
    ntfyPager: { page: async (a: PageCall): Promise<void> => void pageCalls.push(a) },
  };
  const launchBrowser = vi.fn(async () => {
    if (opts.launchError) throw opts.launchError;
    return { close: vi.fn(async () => undefined) };
  });
  return {
    pageCalls,
    run: () =>
      runMymrcScrape({
        mymrc,
        prisma,
        launchBrowser,
        log: () => undefined,
        activeSites: ['woodland'],
      }),
  };
}

describe('session-start failure — ledger row (ADR-0111)', () => {
  it('writes a __session__ auth_failed row so the failure is visible in the ledger', async () => {
    const prisma = fakePrisma(0);
    const h = harness(prisma);

    await expect(h.run()).resolves.toBe(1); // still a non-zero exit — fail loud

    expect(prisma.mymrcSyncRun.create).toHaveBeenCalledTimes(1);
    const row = prisma.rows.at(-1);
    expect(row?.feed).toBe('__session__');
    expect(row?.status).toBe('auth_failed');
    expect(row?.site_id).toBe('site-woodland');
    expect(row?.error).toContain('still logged out after fresh login');
  });

  it('does NOT page on the first failure — the retry gets to heal it first', async () => {
    const h = harness(fakePrisma(0));
    await h.run();
    expect(h.pageCalls).toHaveLength(0);
  });

  it('PAGES once the failure repeats inside the window', async () => {
    const h = harness(fakePrisma(1)); // one earlier failure already in the window
    await h.run();

    expect(h.pageCalls).toHaveLength(1);
    expect(h.pageCalls[0]?.kind).toBe('auth_failed');
    expect(h.pageCalls[0]?.fingerprint).toBe('mymrc-auth-failed:admin');
    // The page carries the operator's next action.
    expect(h.pageCalls[0]?.message).toContain('/admin/mrc-scrape');
    expect(h.pageCalls[0]?.message).toMatch(/2x in the last hour/);
  });

  it('PAGES when the ledger itself is unavailable — bookkeeping never silences an outage', async () => {
    // `prisma: {}` makes every ledger call throw. Fail OPEN.
    const h = harness({});
    await h.run();
    expect(h.pageCalls).toHaveLength(1);
  });
});

// 2026-08-26 — the OTHER way a tick never gets a session: `launchBrowser()`
// itself crashed (chrome-headless-shell SIGSEGV at launch, seen 08-18 boot slot
// and 08-26 1:00 PM top-of-hour). Before this, the throw skipped the ADR-0111
// guard entirely — no `__session__` row, no page, straight to the top-level
// `fatal:` handler. The ledger read green through the whole class.
describe('browser-launch failure — same ledger + paging policy (ADR-0111 extension)', () => {
  const launchError = new Error(
    'browserType.launch: Target page, context or browser has been closed',
  );

  it('exits 1 and writes a __session__ error row instead of throwing to the fatal handler', async () => {
    const prisma = fakePrisma(0);
    const h = harness(prisma, { launchError });

    await expect(h.run()).resolves.toBe(1);

    expect(prisma.mymrcSyncRun.create).toHaveBeenCalledTimes(1);
    const row = prisma.rows.at(-1);
    expect(row?.feed).toBe('__session__');
    expect(row?.status).toBe('error');
    expect(row?.error).toContain('browserType.launch');
  });

  it('does NOT page on the first launch failure — the next tick gets to heal it', async () => {
    const h = harness(fakePrisma(0), { launchError });
    await h.run();
    expect(h.pageCalls).toHaveLength(0);
  });

  it('PAGES when a session-level failure of ANY kind already sits in the window', async () => {
    // The prior row is auth_failed; the count is per-feed, not per-status —
    // a login failure followed by a launch crash is still two dead ticks.
    const h = harness(fakePrisma(1), { launchError });
    await h.run();

    expect(h.pageCalls).toHaveLength(1);
    expect(h.pageCalls[0]?.kind).toBe('error');
    expect(h.pageCalls[0]?.fingerprint).toBe('mymrc-launch-failed:admin');
    expect(h.pageCalls[0]?.message).toContain('/admin/mrc-scrape');
  });

  it('PAGES when the ledger itself is unavailable — fail open, as the login path does', async () => {
    const h = harness({}, { launchError });
    await h.run();
    expect(h.pageCalls).toHaveLength(1);
  });
});

describe('recordSessionFailure — unit', () => {
  it('counts a failure from 65 minutes ago — consecutive top-of-hour ticks land INSIDE the window', async () => {
    // Hourly ticks are ~60 min apart; a 60-min window put the previous tick's
    // row exactly on the boundary, so back-to-back hourly failures never paged.
    const prisma = fakePrisma(0);
    prisma.rows.push({
      site_id: 'site-woodland',
      feed: '__session__',
      status: 'error',
      started_at: new Date(Date.now() - 65 * 60 * 1000),
    });

    const res = await recordSessionFailure({
      prisma,
      activeSites: ['woodland'],
      message: 'boom',
      log: () => undefined,
    });
    expect(res).toEqual({ ledgered: true, recent: 2 });
  });

  it('reports the count of failures in the window, including the one just written', async () => {
    const prisma = fakePrisma(0);
    const first = await recordSessionFailure({
      prisma,
      activeSites: ['woodland'],
      message: 'boom',
      log: () => undefined,
    });
    expect(first).toEqual({ ledgered: true, recent: 1 });

    const second = await recordSessionFailure({
      prisma,
      activeSites: ['woodland'],
      message: 'boom again',
      log: () => undefined,
    });
    expect(second).toEqual({ ledgered: true, recent: 2 });
  });

  it('falls back to any site when the active code has no row', async () => {
    const prisma = fakePrisma(0);
    prisma.site.findFirst = vi
      .fn<(...a: unknown[]) => Promise<{ id: string } | null>>()
      .mockResolvedValueOnce(null) // no row for the active code
      .mockResolvedValueOnce({ id: 'site-fallback' });

    const res = await recordSessionFailure({
      prisma,
      activeSites: ['nosuchsite'],
      message: 'boom',
      log: () => undefined,
    });
    expect(res.ledgered).toBe(true);
    expect(prisma.rows.at(-1)?.site_id).toBe('site-fallback');
  });

  it('fails OPEN (recent=Infinity) when no site row exists at all', async () => {
    const prisma = fakePrisma(0);
    prisma.site.findFirst = vi.fn<(...a: unknown[]) => Promise<{ id: string } | null>>(
      async () => null,
    );

    const res = await recordSessionFailure({
      prisma,
      activeSites: ['woodland'],
      message: 'boom',
      log: () => undefined,
    });
    expect(res).toEqual({ ledgered: false, recent: Number.POSITIVE_INFINITY });
  });
});
