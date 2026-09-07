// ADR-0130 — the ADR-0037 cooldown must survive a PROCESS EXIT.
//
// ## The defect this file pins
//
// The cooldown ledger was `const cooldownLedger = new Map()` in module scope,
// with the comment "One ledger per Node.js process… DR3-Vision runs a single
// replica on CHAD-HQ so this is sufficient."
//
// The replica count was never the assumption that mattered. `dr3-vision-mymrc-scrape`
// is a long-lived CRON HOST that spawns `scripts/mymrc-scrape.mjs` as a FRESH
// child process every hour (`[mymrc-cron …] spawning /app/scripts/mymrc-scrape.mjs`
// → `scrape exit code 0`, hourly, verified in the container's own log). A brand-new
// process gets a brand-new empty Map, so a 24 h cooldown decayed to ZERO and every
// stale-mirror alert re-fired on every tick. Measured from ntfy history, the deltas
// between consecutive `mymrc-stale-mirror:woodland:processed` pages were
// [3601, 3604, 3595, 3595, 3604, 3603, 3601, 3593] seconds — the cron period, for
// four days.
//
// ## What "a process restart" is, in a test
//
// `vi.resetModules()` + a fresh dynamic `import()` gives a NEW module instance with
// a NEW module-scope `Map` — which is precisely what a new Node process gets. The
// durable ledger lives OUTSIDE the module graph (in Postgres in production; in a
// stand-in here), so it is the one thing that survives the reset.
//
// The stand-in below is a dumb conditional-claim key/value store. It is NOT proof
// that the SQL is right — an in-test fake can only be written to agree with the
// implementation. The SQL semantics (`INSERT … ON CONFLICT DO UPDATE … WHERE
// expires_at <= $now` affecting 1 row when claimable and 0 when not) are proven
// against a REAL Postgres in `ntfy-cooldown-store.db.test.ts`. This file proves the
// only thing a fake CAN prove: that `publishNtfy` consults a store that outlives
// the module.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FINGERPRINT = 'mymrc-stale-mirror:woodland:processed';
const DAY_MS = 24 * 60 * 60 * 1000;

interface FetchCall {
  url: string;
  init: RequestInit;
}
let fetchCalls: FetchCall[];

/**
 * Stand-in for the `ntfy_cooldowns` table. Deliberately outside the module graph
 * so `vi.resetModules()` does not clear it — that asymmetry IS the test.
 *
 * Implements ONE required method, matching the structural `CooldownDb` the store
 * asks for. A client that lacks it cannot be registered (fail-closed seam).
 */
class FakeLedgerDb {
  readonly rows = new Map<string, number>();
  calls: string[] = [];

  async $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> {
    this.calls.push(sql.trim().split(/\s+/, 1)[0] ?? '');
    if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
      const [fp, expiresAt, now] = values as [string, string, string];
      const existing = this.rows.get(fp);
      const nowMs = Date.parse(now);
      if (existing !== undefined && existing > nowMs) return 0; // cooldown still active
      this.rows.set(fp, Date.parse(expiresAt));
      return 1; // claimed
    }
    if (sql.trimStart().toUpperCase().startsWith('DELETE')) {
      const [first] = values as [string];
      if (this.rows.delete(first)) return 1;
      return 0;
    }
    throw new Error(`FakeLedgerDb: unexpected SQL ${sql}`);
  }
}

/** Import a FRESH copy of the ntfy module graph — a simulated process restart. */
async function bootProcess(db: FakeLedgerDb | null) {
  vi.resetModules();
  const store = await import('./ntfy-cooldown-store');
  store.setCooldownDb(db);
  const ntfy = await import('./ntfy');
  ntfy.__testing.setSleep(() => Promise.resolve());
  return { ntfy, store };
}

function publishStaleMirror(ntfy: typeof import('./ntfy')) {
  return ntfy.publishNtfy({
    topic: 'dr3-vision-system',
    title: 'MyMRC mirror stopped advancing - woodland [processed]',
    body: 'The MyMRC processed mirror has stopped advancing.',
    priority: 'high',
    fingerprint: FINGERPRINT,
    cooldownMs: DAY_MS,
  });
}

beforeEach(() => {
  fetchCalls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init: RequestInit = {}) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch);
  process.env['NTFY_PUBLISHER_TOKEN'] = 'test-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['NTFY_PUBLISHER_TOKEN'];
  vi.resetModules();
});

describe('ADR-0130 — cooldown durability across a process restart', () => {
  it('NEGATIVE CONTROL: with no durable ledger, a restart loses the cooldown (the storm)', async () => {
    // This is the shipped-before-ADR-0130 behaviour, kept as a permanent control.
    // If this ever stops re-firing, the test below is passing for a reason other
    // than the durable ledger and proves nothing.
    const first = await bootProcess(null);
    expect((await publishStaleMirror(first.ntfy)).outcome).toBe('sent');

    const second = await bootProcess(null); // new process, empty in-memory Map
    expect((await publishStaleMirror(second.ntfy)).outcome).toBe('sent');

    expect(fetchCalls).toHaveLength(2); // Bill's phone buzzed twice
  });

  it('with the durable ledger registered, the 24h cooldown SURVIVES the restart', async () => {
    const ledger = new FakeLedgerDb();

    const first = await bootProcess(ledger);
    expect((await publishStaleMirror(first.ntfy)).outcome).toBe('sent');
    expect(fetchCalls).toHaveLength(1);

    // Hour 2. Fresh process, fresh module-scope Map — same ledger row.
    const second = await bootProcess(ledger);
    expect((await publishStaleMirror(second.ntfy)).outcome).toBe('cooldown-suppressed');

    // Hours 3 and 4.
    const third = await bootProcess(ledger);
    expect((await publishStaleMirror(third.ntfy)).outcome).toBe('cooldown-suppressed');
    const fourth = await bootProcess(ledger);
    expect((await publishStaleMirror(fourth.ntfy)).outcome).toBe('cooldown-suppressed');

    // ONE page across four ticks, not four.
    expect(fetchCalls).toHaveLength(1);
  });

  it('the MyMRC pager (alias-less bundle) shares the SAME durable ledger', async () => {
    // src/lib/mymrc/ntfy.ts cannot import src/lib/ntfy.ts (tsconfig.mymrc.json has
    // no `@/` alias and pins rootDir to src/lib/mymrc), so it carried its OWN
    // in-process Map. It must now claim from the same store, or the storm is
    // fixed for the app and left in place for the worker that actually storms.
    const ledger = new FakeLedgerDb();

    vi.resetModules();
    const s1 = await import('./mymrc/cooldown-store');
    s1.setCooldownDb(ledger);
    const p1 = await import('./mymrc/ntfy');
    await p1.ntfyPager.page({
      kind: 'stale_mirror',
      site: 'woodland',
      feed: 'processed',
      message: 'mirror stopped advancing',
      fingerprint: FINGERPRINT,
      cooldownMs: DAY_MS,
    });
    expect(fetchCalls).toHaveLength(1);

    vi.resetModules();
    const s2 = await import('./mymrc/cooldown-store');
    s2.setCooldownDb(ledger);
    const p2 = await import('./mymrc/ntfy');
    await p2.ntfyPager.page({
      kind: 'stale_mirror',
      site: 'woodland',
      feed: 'processed',
      message: 'mirror stopped advancing',
      fingerprint: FINGERPRINT,
      cooldownMs: DAY_MS,
    });
    expect(fetchCalls).toHaveLength(1); // still one
  });

  it('a DROPPED publish RELEASES the claim so the next tick can retry', async () => {
    // ADR-0036/0037 contract: `dropped` means neither primary nor fallback landed.
    // The caller "may retry on the next watchdog tick" — so a claim taken before
    // the send must be given back when the send fails, or a transient ntfy outage
    // would silence the alert for the whole cooldown window.
    const ledger = new FakeLedgerDb();
    vi.spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch);

    const first = await bootProcess(ledger);
    expect((await publishStaleMirror(first.ntfy)).outcome).toBe('dropped');
    expect(ledger.rows.has(FINGERPRINT)).toBe(false);

    // Next tick, ntfy is back.
    fetchCalls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init: RequestInit = {}) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch);
    const second = await bootProcess(ledger);
    expect((await publishStaleMirror(second.ntfy)).outcome).toBe('sent');
  });

  it('degrades to the in-process ledger (never throws) when the database is down', async () => {
    const broken = {
      $executeRawUnsafe: () => Promise.reject(new Error('Connection refused')),
    };
    vi.resetModules();
    const store = await import('./ntfy-cooldown-store');
    store.setCooldownDb(broken);
    const ntfy = await import('./ntfy');
    ntfy.__testing.setSleep(() => Promise.resolve());

    // First call still pages — a DB outage must not silence the fleet.
    expect((await publishStaleMirror(ntfy)).outcome).toBe('sent');
    // …and the in-process fallback still suppresses within the SAME process.
    expect((await publishStaleMirror(ntfy)).outcome).toBe('cooldown-suppressed');
  });
});
