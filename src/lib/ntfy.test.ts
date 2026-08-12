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
  // Retry backoff sleeps run instantly in tests — we assert retry
  // COUNTS and outcomes, not wall-clock timing.
  __testing.setSleep(() => Promise.resolve());
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
  __testing.resetSleep();
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
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers['Click']).toBe('https://dr3-vision.svdp.us/admin/audit');
  });
});

describe('publishNtfy — fallback on primary failure', () => {
  beforeEach(() => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test_token_value';
  });

  it('falls back to the obscured ntfy.sh topic only after the primary retries are exhausted', async () => {
    fetchImpls = [
      // Primary fails on all three attempts (1 initial + 2 retries).
      () => Promise.resolve(new Response('bad gateway', { status: 502 })),
      () => Promise.resolve(new Response('bad gateway', { status: 502 })),
      () => Promise.resolve(new Response('bad gateway', { status: 502 })),
      // Fallback succeeds on its first attempt.
      () => Promise.resolve(new Response(null, { status: 200 })),
    ];
    const result = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Migration applied 0001_init',
      body: 'applied',
    });
    expect(result.outcome).toBe('fallback-sent');
    expect(fetchCalls).toHaveLength(4);
    // First three calls are the primary (with retries); fourth is the fallback.
    expect(fetchCalls.slice(0, 3).map((c) => c.url)).toEqual([
      'https://ntfy.barnardhq.com/dr3-vision-system',
      'https://ntfy.barnardhq.com/dr3-vision-system',
      'https://ntfy.barnardhq.com/dr3-vision-system',
    ]);
    expect(fetchCalls[3]!.url).toBe('https://ntfy.sh/bhq-fb-dr3v-system-k8m2n');
    const fbHeaders = fetchCalls[3]!.init.headers as Record<string, string>;
    expect(fbHeaders['X-Title']).toBe('[FALLBACK] [DR3-Vision] Migration applied 0001_init');
    expect(fbHeaders['Authorization']).toBeUndefined();
  });

  it('recovers a transient primary blip on retry without ever touching the fallback', async () => {
    // The 2026-06-09 t4-escalation drop: the first attempt fails instantly
    // (connection error), the retry succeeds. The alert must land as `sent`,
    // not `dropped`, and the obscured fallback topic must never be hit.
    fetchImpls = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.resolve(new Response(null, { status: 200 })),
    ];
    const result = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'URGENT: payroll deadline MISSED — Woodland Period 13',
      body: 'intervene',
    });
    expect(result).toEqual({ ok: true, outcome: 'sent' });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls.every((c) => c.url === 'https://ntfy.barnardhq.com/dr3-vision-system')).toBe(
      true,
    );
  });

  it('returns dropped only after every primary AND fallback attempt fails', async () => {
    // 3 primary attempts + 2 fallback attempts = 5 failed fetches.
    fetchImpls = [
      () => Promise.reject(new TypeError('network')),
      () => Promise.reject(new TypeError('network')),
      () => Promise.reject(new TypeError('network')),
      () => Promise.resolve(new Response(null, { status: 503 })),
      () => Promise.resolve(new Response(null, { status: 503 })),
    ];
    const result = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Storm',
      body: 'both down',
    });
    expect(result).toEqual({ ok: false, outcome: 'dropped' });
    expect(fetchCalls).toHaveLength(5);
    expect(
      fetchCalls.slice(0, 3).every((c) => c.url.startsWith('https://ntfy.barnardhq.com')),
    ).toBe(true);
    expect(fetchCalls.slice(3).every((c) => c.url.startsWith('https://ntfy.sh'))).toBe(true);
  });

  it('records a cooldown after a retry-recovered success so it does not double-page', async () => {
    fetchImpls = [
      () => Promise.reject(new TypeError('blip')),
      () => Promise.resolve(new Response(null, { status: 200 })),
    ];
    const args = {
      topic: 'dr3-vision-system',
      title: 'Same',
      body: 'a',
      fingerprint: 'fp-retry',
      cooldownMs: 60_000,
    };
    const first = await publishNtfy(args);
    expect(first.outcome).toBe('sent');
    const second = await publishNtfy({ ...args, body: 'b' });
    expect(second.outcome).toBe('cooldown-suppressed');
  });

  it('returns dropped (no fallback attempted) when topic has no fallback registered', async () => {
    // Primary exhausts its 3 attempts; topic isn't in the fallback map, so
    // no ntfy.sh call is made.
    fetchImpls = [
      () => Promise.resolve(new Response(null, { status: 502 })),
      () => Promise.resolve(new Response(null, { status: 502 })),
      () => Promise.resolve(new Response(null, { status: 502 })),
    ];
    const result = await publishNtfy({
      topic: 'unregistered-topic-name',
      title: 'X',
      body: 'y',
    });
    expect(result).toEqual({ ok: false, outcome: 'dropped' });
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls.every((c) => c.url.startsWith('https://ntfy.barnardhq.com'))).toBe(true);
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

// ────────────────────────────────────────────────────────────────────────
// ADR-0019.5 — header-encoding safety (the 2026-08-05 dropped page)
// ────────────────────────────────────────────────────────────────────────
//
// ROOT CAUSE, reproduced: HTTP header values are ByteStrings (latin-1). Node's
// undici throws
//   TypeError: Cannot convert argument to a ByteString because the character at
//   index 43 has a value of 8212 which is greater than 255
// when a header holds a codepoint > 255. Every DR3 alert title uses an em dash
// (U+2014 = 8212), so `X-Title` threw — on the primary AND, with identical
// headers, on the ntfy.sh fallback. Both "failed" in the same millisecond
// WITHOUT EVER OPENING A SOCKET, which is why the ntfy server looked perfectly
// healthy while the page vanished:
//
//   {"level":40,"time":"2026-08-05T16:00:01.621Z","periodEnd":"2026-08-03",
//    "msg":"[escalation] stranded ntfy dropped (primary+fallback failed)"}
//
// This is the FOURTH re-discovery of this class on the fleet: the bash/Python
// helpers were fixed 2026-05-06, noc-master's Node publisher by ADR-0063
// (2026-05-22), whose own open question asked whether the fix should be lifted
// to a shared utility "to prevent a fourth re-discovery". DR3-Vision's helper
// was never patched.
//
// AMENDED BY ADR-0093 (contract v2): the sanitizer now emits PURE ASCII and
// folds accents (`café` -> `cafe`), where v1 stopped at latin-1. undici's wall is
// U+00FF, but httpx — used by other fleet publishers — raises above U+007F, and
// the fleet keeps ONE contract set by the strictest client. Note the consequence
// for the mock below: it validates like undici, so it CANNOT catch a regression
// from ASCII back to latin-1. The pure-ASCII assertion does that, and the shared
// fleet vectors pin it in `src/__tests__/ntfy-header-safety-sweep.test.ts`.
//
// CRITICAL TEST-DESIGN NOTE: the suite above mocks `globalThis.fetch`, which
// accepts any object as headers and therefore CANNOT observe this bug — a mock
// is exactly why it shipped. The mock below constructs a real `Request` from the
// headers, so it validates them the way undici does. If the sanitizer regresses,
// these tests throw with the production error rather than passing quietly.

/**
 * Replace the whole fetch double with one that enforces real ByteString header
 * validation on EVERY attempt.
 *
 * Covering every attempt is the point. An earlier draft of this helper pushed a
 * single validating impl onto `fetchImpls`; the publisher's first attempt threw,
 * the RETRY fell through to the harness's default 200 mock, and the test passed
 * green against unsanitized code. A test that survives the bug it exists to
 * catch is worse than no test, so this overrides the mock outright.
 */
function bytestringValidatingFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init: RequestInit = {}) => {
    fetchCalls.push({ url, init });
    const impl = fetchImpls.shift();
    // Throws TypeError on any header codepoint > 255, exactly like undici.
    new Request('https://example.invalid/', {
      method: 'POST',
      body: 'x',
      headers: init.headers as HeadersInit,
    });
    if (impl) return impl(url, init);
    return Promise.resolve(new Response('ok', { status: 200 }));
  }) as typeof fetch);
}

describe('header encoding safety (ADR-0019.5)', () => {
  beforeEach(() => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tok';
    __testing.clearCooldownLedger();
  });

  // The exact payload the 2026-08-05 09:00:01 PT stranded page built.
  const AUG5_TITLE = 'URGENT: bonus period STRANDED — DR3 Eugene Period 16';

  it('publishes the EXACT 2026-08-05 stranded payload successfully', async () => {
    bytestringValidatingFetch();
    const res = await publishNtfy({
      topic: 'dr3-vision-system',
      title: AUG5_TITLE,
      body: 'DR3 Eugene Period 16 (2026) is still in state ‘partially_signed’ — MISSED its payroll window 1 day ago.',
      priority: 'urgent',
      tags: ['rotating_light', 'bonus', 'stranded'],
      fingerprint: 'bonus-period-stranded:eugene:f7f33bac',
    });
    expect(res).toEqual({ ok: true, outcome: 'sent' });
  });

  it('transliterates the em dash rather than mangling the sentence', async () => {
    bytestringValidatingFetch();
    await publishNtfy({ topic: 'dr3-vision-system', title: AUG5_TITLE, body: 'b' });
    const title = String((fetchCalls[0]!.init.headers as Record<string, string>)['X-Title']);
    expect(title).toContain('STRANDED - DR3 Eugene Period 16');
    expect(title).not.toContain('—');
    // A readable dash, not a '?' — the operator still gets a sentence.
    expect(title).not.toContain('?');
  });

  it('every header value is pure ASCII, not just the title (contract v2)', async () => {
    // ADR-0093 tightened this from latin-1 to ASCII. undici's own wall is U+00FF,
    // so `café` would sail through the validating mock below — but httpx, which
    // other fleet publishers use, raises above U+007F. One fleet, one contract,
    // set by the strictest client. The threshold here is 128, not 256.
    bytestringValidatingFetch();
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Quota ≥ 90% — “Woodland” … done',
      body: 'b',
      tags: ['warning', 'café→x'],
      clickUrl: 'https://dr3-vision.svdp.us/bonus?q=—',
    });
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    for (const [k, v] of Object.entries(headers)) {
      for (const ch of String(v)) {
        expect(
          ch.codePointAt(0)! < 128,
          `header ${k} holds U+${ch.codePointAt(0)!.toString(16)} (${ch})`,
        ).toBe(true);
      }
    }
    // Folded, not degraded: an accented tag stays a readable word. `caf?` would
    // be a readability regression rather than a fix.
    expect(String(headers['Tags'])).toContain('cafe->x');
  });

  it('transliterates the punctuation fleet titles actually use (ADR-0063 §1 set)', async () => {
    bytestringValidatingFetch();
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: '—–− ‘’ “” … × ≥ ≤ →',
      body: 'b',
    });
    const title = String((fetchCalls[0]!.init.headers as Record<string, string>)['X-Title']);
    expect(title).toContain('--- ');
    expect(title).toContain("'' ");
    expect(title).toContain('"" ');
    expect(title).toContain('... ');
    expect(title).toContain('x ');
    expect(title).toContain('>= <= ->');
  });

  it('a codepoint with no transliteration becomes ? rather than throwing', async () => {
    // The backstop matters more than the mapping: an unmapped glyph (an emoji in
    // a vendor name, say) must degrade to a sendable page, never a lost one.
    bytestringValidatingFetch();
    const res = await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'vendor \u{1F600} down',
      body: 'b',
    });
    expect(res.outcome).toBe('sent');
    expect(String((fetchCalls[0]!.init.headers as Record<string, string>)['X-Title'])).toContain(
      'vendor ?',
    );
  });

  it('the BODY keeps its Unicode — only headers are constrained', async () => {
    // Bodies are UTF-8 and may hold anything; sanitizing them would degrade
    // every alert's readability for no reason.
    bytestringValidatingFetch();
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'ascii only',
      body: 'period 2026-07-21→08-03 — stranded',
    });
    expect(String(fetchCalls[0]!.init.body)).toContain('→');
    expect(String(fetchCalls[0]!.init.body)).toContain('—');
  });

  it('the FALLBACK leg is sanitized too — it failed identically on 2026-08-05', async () => {
    // Primary rejects; fallback must still deliver. Before the fix both threw on
    // the same header, which is why the failure looked like a total outage.
    // The primary makes up to 3 attempts (PRIMARY_RETRY_BACKOFF_MS has 2 entries),
    // so all three must fail before the fallback leg is reached.
    __testing.setSleep(async () => undefined);
    bytestringValidatingFetch();
    for (let i = 0; i < 3; i++) {
      fetchImpls.push(async () => new Response('nope', { status: 500 }));
    }
    const res = await publishNtfy({
      topic: 'dr3-vision-system',
      title: AUG5_TITLE,
      body: 'b',
    });
    expect(res).toEqual({ ok: true, outcome: 'fallback-sent' });
    const fbTitle = String((fetchCalls.at(-1)!.init.headers as Record<string, string>)['X-Title']);
    expect(fbTitle).toContain('[FALLBACK]');
    expect(fbTitle).not.toContain('—');
  });
});
