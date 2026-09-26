// ADR-0133 — the MyMRC pager is a REDACTION BOUNDARY, not a passthrough.
//
// On 2026-09-16 the page body was `${alert.message}\n\nfingerprint=…` with no
// processing of any kind, so whatever a caller handed it went to Bill's phone
// and into the ntfy server's 7-day message cache verbatim. What a caller handed
// it that morning was Playwright's call log for an authenticated Aura POST.
//
// Two properties are pinned here, and the second one exists precisely because
// the first one is a promise about OTHER files:
//   1. every sink redacts before it publishes; and
//   2. the publisher redacts AGAIN, so a future caller that forgets cannot
//      re-open this hole.
//
// Every secret below is SYNTHESISED (see redact-secrets.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ntfyPager, fingerprint, GRADE_BY_KIND } from './ntfy';
import { __cooldownTesting } from './cooldown-store';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[];
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  __cooldownTesting.reset();
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch);
  for (const k of ['NTFY_PUBLISHER_TOKEN', 'NTFY_BASE_URL']) ORIGINAL[k] = process.env[k];
  process.env['NTFY_PUBLISHER_TOKEN'] = 'test-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const body = (): string => String(calls[0]?.init.body ?? '');

const LEAKY = [
  'apiRequestContext.post: Timeout 45000ms exceeded.',
  'Call log:',
  '  - → POST https://mymrc.example.force.com/s/sfsites/aura?r=7',
  '  -   cookie: BrowserId=FAKEbrowserid; sid=00Dxx0000000FAKE!AQEAQFAKEsessionFAKEtoken0000; oid=00Dxx0000000FAKE',
  '  -   authorization: Bearer FAKEbearerFAKEtoken',
].join('\n');

describe('ntfyPager — redaction at the publisher', () => {
  it('never publishes a header block, even when the caller forgot to redact', async () => {
    await ntfyPager.page({
      kind: 'error',
      site: 'woodland',
      feed: 'outbound',
      message: LEAKY,
      fingerprint: fingerprint.error('woodland', 'outbound'),
    });

    expect(calls).toHaveLength(1);
    expect(body()).not.toContain('cookie:');
    expect(body()).not.toContain('sid=');
    expect(body()).not.toContain('Bearer');
    expect(body()).not.toMatch(/00D[0-9A-Za-z]{12,15}!/);
  });

  it('keeps the diagnosis — first line, request line and fingerprint', async () => {
    await ntfyPager.page({
      kind: 'error',
      site: 'woodland',
      feed: 'outbound',
      message: LEAKY,
      fingerprint: 'mymrc-error:woodland:outbound',
    });
    expect(body()).toContain('apiRequestContext.post: Timeout 45000ms exceeded.');
    expect(body()).toContain('→ POST https://mymrc.example.force.com/s/sfsites/aura?r=7');
    expect(body()).toContain('fingerprint=mymrc-error:woodland:outbound');
  });

  it('caps the body — the page is a pointer, the sync-run row is the record', async () => {
    const long = `padding ${'x'.repeat(5000)} end`;
    await ntfyPager.page({
      kind: 'error',
      site: 'woodland',
      feed: 'outbound',
      message: long,
      fingerprint: 'mymrc-error:woodland:outbound',
    });
    expect(body().length).toBeLessThan(800);
    expect(body()).toContain('truncated');
    // The fingerprint line survives the cap — it is how a page is deduped and
    // how an operator ties the page to its ledger row.
    expect(body()).toContain('fingerprint=mymrc-error:woodland:outbound');
  });

  it('leaves a short, clean message byte-for-byte alone', async () => {
    await ntfyPager.page({
      kind: 'stale_mirror',
      site: 'woodland',
      feed: 'processed',
      message: 'mirror not current: newest processed record is 2026-09-10 (5.2d behind)',
      fingerprint: 'mymrc-stale:woodland:processed',
    });
    expect(body()).toBe(
      'mirror not current: newest processed record is 2026-09-10 (5.2d behind)\n\n' +
        'fingerprint=mymrc-stale:woodland:processed',
    );
  });

  it('honours the caller priority the error re-grade supplies', async () => {
    await ntfyPager.page({
      kind: 'error',
      site: 'woodland',
      feed: 'outbound',
      message: 'boom',
      fingerprint: 'mymrc-error-sustained:woodland:outbound',
      priority: 'high',
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Priority']).toBe('high');
    // …and still defaults to the ADR-0130 §6 grade when the caller says nothing.
    expect(GRADE_BY_KIND.error.priority).toBe('default');
  });
});

describe('bridge_gate (OPEN-ITEMS 0.CA)', () => {
  it('is titled as a backfill gate, not a sync error, at high, with the caller click', async () => {
    await ntfyPager.page({
      kind: 'bridge_gate',
      site: 'woodland',
      message: 'floor moved unexplained',
      fingerprint: 'inbound-bridge-floor-drift',
      click: 'https://dr3-vision.svdp.us/dashboard/woodland/loads-inventory',
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-Title']).toBe(
      '[DR3-Vision] Inventory bridge backfill: floor gate FAILED - woodland',
    );
    expect(headers['X-Title']).not.toMatch(/sync error/i);
    expect(headers['Priority']).toBe('high');
    expect(headers['Click']).toBe('https://dr3-vision.svdp.us/dashboard/woodland/loads-inventory');
  });
});

describe('fingerprints', () => {
  it('a sustained error has its OWN fingerprint', () => {
    // An escalation that re-uses the fingerprint of the page it escalates is
    // swallowed by that page's own 6 h cooldown and never arrives.
    expect(fingerprint.error('woodland', 'outbound')).toBe('mymrc-error:woodland:outbound');
    expect(fingerprint.errorSustained('woodland', 'outbound')).toBe(
      'mymrc-error-sustained:woodland:outbound',
    );
  });
});
