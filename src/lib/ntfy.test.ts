import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testing,
  publishContainerStart,
  publishMigrationApplied,
  publishNtfy,
  publishUnhandledError,
} from './ntfy';

// Tests for `src/lib/ntfy.ts`. These guard the contract that matters
// to the operator's phone:
//   - Token-less env is a successful no-op (CI + fresh checkouts).
//   - Successful primary publish carries the right ADR-0036 headers
//     (X-Title, Authorization, Click, Priority, Tags).
//   - Primary failure falls through to the obscured ntfy.sh fallback
//     with `[FALLBACK]` prefix and Authorization stripped.
//   - Cooldown suppression is per-fingerprint and respects the caller-
//     supplied window (ADR-0037 §3).
//   - Convenience wrappers (publishContainerStart, publishMigrationApplied,
//     publishUnhandledError) hit the right topic + priority.
//
// We mock `globalThis.fetch` rather than the helper internals — that's
// the contract callers care about, and it lets us assert URL + headers
// + body verbatim.

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[];
let fetchImpls: Array<(url: string, init: RequestInit) => Promise<Response>>;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

function snapshotEnv(...keys: string[]) {
  for (const k of keys) ORIGINAL_ENV[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  __testing.clearCooldownLedger();
  fetchCalls = [];
  fetchImpls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init: RequestInit = {}) => {
    fetchCalls.push({ url, init });
    const impl = fetchImpls.shift();
    if (impl) return impl(url, init);
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch);
  snapshotEnv('NTFY_PUBLISHER_TOKEN', 'NTFY_BASE_URL');
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});

describe('publishNtfy — fail-soft when unconfigured', () => {
  it('returns unconfigured + makes no HTTP call when token is unset', async () => {
    delete process.env['NTFY_PUBLISHER_TOKEN'];
    const result = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Anything',
      body: 'should not fire',
    });
    expect(result).toEqual({ ok: true, outcome: 'unconfigured' });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('publishNtfy — successful primary publish', () => {
  beforeEach(() => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test_token_value';
    delete process.env['NTFY_BASE_URL'];
  });

  it('POSTs to ntfy.barnardhq.com with the ADR-0036 headers', async () => {
    const result = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Container started',
      body: 'boot v1.2.3',
      priority: 'high',
      tags: ['boot', 'dr3-vision'],
    });
    expect(result.outcome).toBe('sent');
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe('https://ntfy.barnardhq.com/dr3-vision-system');
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('boot v1.2.3');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['X-Title']).toBe('[DR3-Vision] Container started');
    expect(headers['Priority']).toBe('high');
    expect(headers['Click']).toBe('https://noc-mastercontrol.barnardhq.com/status/dr3-vision');
    expect(headers['Tags']).toBe('boot,dr3-vision');
    expect(headers['Authorization']).toBe('Bearer tk_test_token_value');
  });

  it('honours an explicit clickUrl override', async () => {
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'X',
      body: 'y',
      clickUrl: 'https://dr3-vision.svdp.us/admin/audit',
    });
    const headers = (fetchCalls[0]!.init.headers as Record<string, string>);
    expect(headers['Click']).toBe('https://dr3-vision.svdp.us/admin/audit');
  });
});

describe('publishNtfy — fallback on primary failure', () => {
  beforeEach(() => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test_token_value';
  });

  it('falls back to the obscured ntfy.sh topic with [FALLBACK] prefix and no Authorization', async () => {
    fetchImpls = [
      // Primary returns 502.
      () => Promise.resolve(new Response('bad gateway', { status: 502 })),
      // Fallback succeeds.
      () => Promise.resolve(new Response(null, { status: 200 })),
    ];
    const result = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Migration applied 0001_init',
      body: 'applied',
    });
    expect(result.outcome).toBe('fallback-sent');
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toBe('https://ntfy.barnardhq.com/dr3-vision-system');
    expect(fetchCalls[1]!.url).toBe('https://ntfy.sh/bhq-fb-dr3v-system-k8m2n');
    const fbHeaders = fetchCalls[1]!.init.headers as Record<string, string>;
    expect(fbHeaders['X-Title']).toBe('[FALLBACK] [DR3-Vision] Migration applied 0001_init');
    expect(fbHeaders['Authorization']).toBeUndefined();
  });

  it('returns dropped when both primary and fallback fail', async () => {
    fetchImpls = [
      () => Promise.reject(new TypeError('network')),
      () => Promise.resolve(new Response(null, { status: 503 })),
    ];
    const result = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Storm',
      body: 'both down',
    });
    expect(result).toEqual({ ok: false, outcome: 'dropped' });
    expect(fetchCalls).toHaveLength(2);
  });

  it('returns dropped (no fallback attempted) when topic has no fallback registered', async () => {
    fetchImpls = [() => Promise.resolve(new Response(null, { status: 502 }))];
    const result = await publishNtfy({
      topic: 'unregistered-topic-name',
      title: 'X',
      body: 'y',
    });
    expect(result).toEqual({ ok: false, outcome: 'dropped' });
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('publishNtfy — cooldown suppression (ADR-0037 §3)', () => {
  beforeEach(() => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test_token_value';
  });

  it('suppresses second call within cooldown window for the same fingerprint', async () => {
    const args = {
      topic: 'dr3-vision-system',
      title: 'Same title',
      body: 'first',
      fingerprint: 'fp-A',
      cooldownMs: 60_000,
    };
    const first = await publishNtfy(args);
    expect(first.outcome).toBe('sent');
    const second = await publishNtfy({ ...args, body: 'second' });
    expect(second.outcome).toBe('cooldown-suppressed');
    expect(fetchCalls).toHaveLength(1);
  });

  it('lets through different fingerprints', async () => {
    const a = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'A',
      body: 'a',
      fingerprint: 'fp-A',
    });
    const b = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'B',
      body: 'b',
      fingerprint: 'fp-B',
    });
    expect(a.outcome).toBe('sent');
    expect(b.outcome).toBe('sent');
    expect(fetchCalls).toHaveLength(2);
  });

  it('lets the alert through after the cooldown expires', async () => {
    vi.useFakeTimers();
    const args = {
      topic: 'dr3-vision-system',
      title: 'Same',
      body: 'a',
      fingerprint: 'fp-X',
      cooldownMs: 1_000,
    };
    await publishNtfy(args);
    vi.advanceTimersByTime(2_000);
    const second = await publishNtfy({ ...args, body: 'b' });
    vi.useRealTimers();
    expect(second.outcome).toBe('sent');
    expect(fetchCalls).toHaveLength(2);
  });
});

describe('convenience wrappers', () => {
  beforeEach(() => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test_token_value';
  });

  it('publishContainerStart hits dr3-vision-container at default priority', async () => {
    await publishContainerStart({ version: '0.1.2', commitSha: 'deadbee1234' });
    const call = fetchCalls[0]!;
    expect(call.url).toBe('https://ntfy.barnardhq.com/dr3-vision-container');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Priority']).toBe('default');
    expect(headers['X-Title']).toBe('[DR3-Vision] Container started');
    expect(call.init.body).toContain('0.1.2');
    expect(call.init.body).toContain('deadbee');
  });

  it('publishMigrationApplied hits dr3-vision-system and includes the migration name', async () => {
    await publishMigrationApplied({ migrationName: '0042_add_widget_table' });
    const call = fetchCalls[0]!;
    expect(call.url).toBe('https://ntfy.barnardhq.com/dr3-vision-system');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['X-Title']).toBe('[DR3-Vision] Migration applied 0042_add_widget_table');
    expect(headers['Priority']).toBe('default');
  });

  it('publishUnhandledError uses high priority and dedupes by error stack', async () => {
    const err = new Error('database connection lost');
    err.stack =
      'Error: database connection lost\n    at handler (/app/route.ts:42:7)\n    at next (/app/middleware.ts:10:3)';
    const first = await publishUnhandledError({ err, context: 'request /api/foo' });
    const second = await publishUnhandledError({ err, context: 'request /api/bar' });
    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('cooldown-suppressed');
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers['Priority']).toBe('high');
    expect(headers['X-Title']).toBe(
      '[DR3-Vision] Unhandled error: Error: database connection lost',
    );
  });
});
