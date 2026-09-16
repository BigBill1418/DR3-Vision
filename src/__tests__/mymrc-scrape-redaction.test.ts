// ADR-0133 — the hourly worker's own sinks.
//
// `scripts/mymrc-scrape.mjs` owns two of the five places the 2026-09-16 text
// landed: the `feed='__session__'` row it writes to `mymrc_sync_runs`, and the
// `mymrc-sync[…]:` lines it writes to the container's stdout (which Alloy ships
// to Loki). It is a `.mjs` compiled from nothing, so it cannot import the TS
// redactor directly — it takes it through the SAME injected `mymrc` surface it
// already takes `syncSite` and `ntfyPager` through.
//
// The fail-closed half matters as much as the wiring: a build whose `dist/mymrc`
// predates this change has no `redactSecrets`, and a worker that silently fell
// back to publishing the raw text would re-open the hole at exactly the moment
// nobody is looking. Every secret below is SYNTHESISED.

import { describe, expect, it, vi } from 'vitest';
import { runMymrcScrape, recordSessionFailure } from '../../scripts/mymrc-scrape.mjs';
import { redactSecrets } from '../lib/mymrc/redact-secrets';

type PageCall = { kind: string; site: string; message: string; fingerprint: string };
type LedgerRow = {
  site_id: string;
  feed: string;
  status: string;
  error?: string;
  started_at: Date;
};

const LOGIN_CALL_LOG = [
  'locator.fill: Timeout 45000ms exceeded.',
  'Call log:',
  '  - → POST https://mymrc.example.force.com/s/login',
  '  -   cookie: BrowserId=FAKEbrowserid; sid=00Dxx0000000FAKE!AQEAQFAKEsessionFAKEtoken0000',
  '  -   authorization: Bearer FAKEbearerFAKEtoken',
].join('\n');

/** Prisma double holding the ledger in memory; `priorFailures` seeds the window. */
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
    site: { findFirst: vi.fn(async () => ({ id: 'site-woodland' })) },
    mymrcSyncRun: {
      create: vi.fn(async ({ data }: { data: LedgerRow }) => {
        rows.push(data);
        return data;
      }),
      count: vi.fn(async () => rows.length),
    },
  };
}

function harness(prisma: unknown, opts: { withRedactor?: boolean } = {}) {
  const pageCalls: PageCall[] = [];
  const lines: string[] = [];
  const mymrc: Record<string, unknown> = {
    setCooldownDb: vi.fn(),
    CredentialsNotConfiguredError: class extends Error {},
    loadAdminCredentials: vi.fn(async () => ({ username: 'admin@example.test', password: 'pw' })),
    createPortalClient: vi.fn(async () => {
      throw new Error(LOGIN_CALL_LOG);
    }),
    playwrightRecordFieldsSession: vi.fn(() => ({})),
    createRecordFieldsClient: vi.fn(() => ({ fetchRecordFields: vi.fn() })),
    syncSite: vi.fn(async () => []),
    checkDeadman: vi.fn(async () => undefined),
    SITE_CODES: ['eugene', 'woodland'],
    ntfyPager: { page: async (a: PageCall): Promise<void> => void pageCalls.push(a) },
  };
  // A build that carries the helper vs one that predates it.
  if (opts.withRedactor !== false) mymrc['redactSecrets'] = redactSecrets;

  return {
    pageCalls,
    lines,
    run: () =>
      runMymrcScrape({
        mymrc,
        prisma,
        launchBrowser: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
        log: (_l: string, m: string) => void lines.push(m),
        activeSites: ['woodland'],
      }),
  };
}

const clean = (text: string): void => {
  expect(text).not.toContain('cookie:');
  expect(text).not.toContain('sid=');
  expect(text).not.toContain('Bearer');
  expect(text).not.toMatch(/00D[0-9A-Za-z]{12,15}!/);
};

describe('mymrc-scrape — the __session__ row and the stdout log are redaction boundaries', () => {
  it('a login-timeout call log never reaches the ledger row or the log line', async () => {
    const prisma = fakePrisma(0);
    const h = harness(prisma);

    await expect(h.run()).resolves.toBe(1);

    const row = prisma.rows.at(-1);
    clean(String(row?.error));
    clean(h.lines.join('\n'));
    // The diagnosis survives — this is a redactor, not a mute button.
    expect(String(row?.error)).toContain('Timeout 45000ms exceeded.');
  });

  it('the page body is redacted on the repeat that actually publishes', async () => {
    const h = harness(fakePrisma(1)); // a prior failure already sits in the window
    await h.run();

    expect(h.pageCalls).toHaveLength(1);
    clean(h.pageCalls[0]?.message ?? '');
    expect(h.pageCalls[0]?.message).toContain('/admin/mrc-scrape');
  });

  it('FAILS CLOSED on a build with no redactor — withholds rather than publishes', async () => {
    const prisma = fakePrisma(1);
    const h = harness(prisma, { withRedactor: false });
    await h.run();

    const row = prisma.rows.at(-1);
    clean(String(row?.error));
    clean(h.pageCalls[0]?.message ?? '');
    expect(String(row?.error)).toContain('withheld');
    // …and the failure is still LOUD: the row exists, the page fired, exit is 1.
    expect(row?.feed).toBe('__session__');
    expect(h.pageCalls).toHaveLength(1);
  });
});

describe('recordSessionFailure — redacts the message it is handed', () => {
  it('stores the redacted text', async () => {
    const prisma = fakePrisma(0);
    await recordSessionFailure({
      prisma,
      activeSites: ['woodland'],
      message: LOGIN_CALL_LOG,
      redact: redactSecrets,
      log: () => undefined,
    });
    clean(String(prisma.rows.at(-1)?.error));
  });

  it('withholds when no redactor is supplied — a forgetful caller cannot leak', async () => {
    const prisma = fakePrisma(0);
    await recordSessionFailure({
      prisma,
      activeSites: ['woodland'],
      message: LOGIN_CALL_LOG,
      log: () => undefined,
    } as unknown as Parameters<typeof recordSessionFailure>[0]);
    clean(String(prisma.rows.at(-1)?.error));
    expect(String(prisma.rows.at(-1)?.error)).toContain('withheld');
  });
});
