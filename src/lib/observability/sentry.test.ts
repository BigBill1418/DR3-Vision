// ADR-0022 Amendment 1 — the GlitchTip scrubbing policy shared by the browser
// (floor tablets) and server inits, plus the browser volume cap. Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_MAX_EVENTS_PER_MINUTE,
  browserInitOptions,
  createRateLimiter,
  glitchTipInitOptions,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  type SentryBreadcrumb,
  type SentryErrorEvent,
} from '@/lib/observability/sentry';

const DSN = 'https://testkey@errors.barnardhq.com/26';
// Synthetic 32-char base64url survey token (same shape as src/lib/survey/tokens.ts).
const TOKEN = 'Zm9vYmFyYmF6cXV4X3N5bnRoZXRpYy0x';
const NAME = 'Test Operator';

function syntheticEvent(): SentryErrorEvent {
  return {
    type: undefined,
    message: 'PIN 4821 rejected <op@example.test>',
    transaction: `/survey/${TOKEN}`,
    tags: { site: 'woodland', page: `https://dr3-vision.svdp.us/survey/${TOKEN}` },
    user: { id: 'u-test-1', username: NAME, email: 'op@example.test', ip_address: '10.0.0.9' },
    extra: { arguments: [{ pin: '4821', name: NAME }] },
    contexts: {
      browser: { name: 'Safari' },
      os: { name: 'iPadOS' },
      device: { model: 'iPad' },
      floor: { operator: NAME },
    },
    request: {
      url: `https://dr3-vision.svdp.us/survey/${TOKEN}?name=Test%20Operator&pin=4821`,
      query_string: 'name=Test%20Operator&pin=4821',
      data: '{"pin":"4821","name":"Test Operator"}',
      cookies: { session: 'synthetic' },
      headers: {
        Authorization: 'Bearer synthetic',
        authorization: 'Bearer synthetic',
        Cookie: 'a=b',
        'X-Forwarded-For': '10.0.0.9',
        Referer: `https://dr3-vision.svdp.us/survey/${TOKEN}?pin=4821`,
        'User-Agent': 'iPad',
      },
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `bad pin 4821 from op@example.test at /api/survey/${TOKEN}`,
          stacktrace: {
            frames: [
              {
                abs_path: `https://dr3-vision.svdp.us/survey/${TOKEN}`,
                filename: 'app:///_next/static/chunks/main-app-643d3742596340f5.js',
                vars: { pin: '4821' },
              },
            ],
          },
        },
      ],
    },
    breadcrumbs: [
      { category: 'ui.click', message: 'button.keypad-digit[aria-label="1"]' },
      { category: 'ui.input', message: 'input[name="pin"]' },
      { category: 'console', message: `Signed in as ${NAME}` },
      {
        category: 'fetch',
        message: `POST for ${NAME}`,
        data: {
          method: 'POST',
          url: `/api/survey/${TOKEN}?operator=Test%20Operator`,
          status_code: 401,
          request_body_size: 12,
          body: '{"pin":"4821"}',
        },
      },
      {
        category: 'navigation',
        data: { from: '/operator/woodland/u-test-1?x=1', to: `/survey/${TOKEN}` },
      },
    ],
  };
}

describe('scrubEvent', () => {
  const out = scrubEvent(syntheticEvent())!;
  const serialized = JSON.stringify(out);

  it('leaves no PIN digits, name, email, IP or survey token anywhere in the event', () => {
    for (const leak of ['4821', NAME, 'Test%20Operator', 'op@example.test', '10.0.0.9', TOKEN]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('keeps only User-Agent, matched case-insensitively (Referer/Authorization/Cookie/XFF go)', () => {
    expect(out.request?.headers).toEqual({ 'User-Agent': 'iPad' });
  });

  it('removes request bodies, cookies and query strings; tokens become placeholders', () => {
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.url).toBe('https://dr3-vision.svdp.us/survey/[token]');
    expect(out.transaction).toBe('/survey/[token]');
  });

  it('keeps only the opaque user id', () => {
    expect(out.user).toEqual({ id: 'u-test-1' });
    const anon = syntheticEvent();
    anon.user = { username: NAME };
    expect(scrubEvent(anon)!.user).toBeUndefined();
  });

  it('drops extra and keeps only browser/os/device contexts', () => {
    expect(out.extra).toBeUndefined();
    expect(Object.keys(out.contexts ?? {}).sort()).toEqual(['browser', 'device', 'os']);
  });

  it('scrubs exception values and stack frames, keeping chunk file names', () => {
    const ex = out.exception!.values![0]!;
    expect(ex.value).toBe('bad pin [digits] from [email] at /api/survey/[token]');
    const frame = ex.stacktrace!.frames![0]!;
    expect(frame.abs_path).toBe('https://dr3-vision.svdp.us/survey/[token]');
    expect(frame.filename).toBe('app:///_next/static/chunks/main-app-643d3742596340f5.js');
    expect(frame.vars).toBeUndefined();
  });

  it('drops UI/console crumbs; others lose message and non-allowlisted data', () => {
    expect(out.breadcrumbs?.map((b) => b.category)).toEqual(['fetch', 'navigation']);
    expect(out.breadcrumbs?.[0]).toEqual({
      category: 'fetch',
      data: { method: 'POST', url: '/api/survey/[token]', status_code: 401 },
    });
    // A record id (cuid-ish user id) is NOT a token and stays debuggable.
    expect(out.breadcrumbs?.[1]?.data).toEqual({
      from: '/operator/woodland/u-test-1',
      to: '/survey/[token]',
    });
  });
});

describe('scrubUrl / scrubText', () => {
  it('replaces any 32+ char base64url segment, but keeps UUIDs and short ids', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(scrubUrl(`https://h/x/${TOKEN}/y`)).toBe('https://h/x/[token]/y');
    expect(scrubUrl(`/operator/load/${uuid}`)).toBe(`/operator/load/${uuid}`);
    expect(scrubUrl('/dashboard/woodland/load/clx1a2b3c4d5e6f7g8h9i0j1k')).toBe(
      '/dashboard/woodland/load/clx1a2b3c4d5e6f7g8h9i0j1k',
    );
  });

  it('documented residual: a NAME inside free text is not detectable and survives', () => {
    expect(scrubText(`failed for ${NAME}`)).toBe(`failed for ${NAME}`);
  });

  it('leaves short numbers (HTTP status) alone', () => {
    expect(scrubText('HTTP 401 after 3 tries')).toBe('HTTP 401 after 3 tries');
    expect(scrubText('PIN 0042')).toBe('PIN [digits]');
  });
});

describe('token containing a 4-6 digit run (review round 2)', () => {
  // 32+ char base64url with an embedded digit run: masking digits first used to
  // break the segment below 32 chars, so part of the token leaked.
  const DIGIT_TOKEN = 'Yz012345AbCdEfGhIjKlMnOpQrStUvWx';
  it('is fully redacted in exception text and in a breadcrumb url', () => {
    const e: SentryErrorEvent = {
      type: undefined,
      exception: { values: [{ value: `fetch https://h.test/x/${DIGIT_TOKEN} failed` }] },
      breadcrumbs: [{ category: 'fetch', data: { url: `/x/${DIGIT_TOKEN}/y` } }],
    };
    const out = scrubEvent(e)!;
    expect(out.exception!.values![0]!.value).toBe('fetch https://h.test/x/[token] failed');
    expect(out.breadcrumbs![0]!.data).toEqual({ url: '/x/[token]/y' });
    expect(JSON.stringify(out)).not.toMatch(/AbCdEfGh|Yz0|12345/);
  });

  it('masks a bare token word in text but keeps long error codes', () => {
    expect(scrubText(`grant ${DIGIT_TOKEN} expired`)).toBe('grant [token] expired');
    expect(scrubText('throughput_machine_not_configured: no designation')).toBe(
      'throughput_machine_not_configured: no designation',
    );
  });

  it('masks number-typed tag values and non-ASCII digit runs, but not UUIDs', () => {
    const e: SentryErrorEvent = {
      type: undefined,
      tags: { pin_guess: 4821 },
      message: 'PIN ٤٨٢١ id 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    };
    const out = scrubEvent(e)!;
    expect(out.tags?.['pin_guess']).toBe('[digits]');
    expect(out.message).toBe('PIN [digits] id 3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });
});

describe('free-text scrub boundaries (security review of e1503b9)', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('masks digit runs glued to letters (digit-only boundary, any script)', () => {
    expect(scrubText('pin1234')).toBe('pin[digits]');
    expect(scrubText('PIN=123456x')).toBe('PIN=[digits]x');
    expect(scrubText('x1234y')).toBe('x[digits]y');
    expect(scrubText('op\uFF11\uFF12\uFF13\uFF14')).toBe('op[digits]'); // fullwidth
    expect(scrubText('PIN \u0664\u0668\u0662\u0661')).toBe('PIN [digits]'); // Arabic-Indic
    expect(scrubText('1234567')).toBe('1234567'); // 7+ digits is not PIN-shaped
  });

  it('keeps UUIDs intact; haul numbers are masked (ADR-0022 Am.1 promises no exception)', () => {
    expect(scrubText(`load ${uuid} failed`)).toBe(`load ${uuid} failed`);
    expect(scrubText('haul H-145388 rejected')).toBe('haul H-[digits] rejected');
  });

  it('masks a whole email even when a UUID sits inside it', () => {
    expect(scrubText(`to a@${uuid}.com now`)).toBe('to [email] now');
    expect(scrubText(`to ${uuid}@x.com now`)).toBe('to [email] now');
    expect(scrubText(`to user.${uuid}@host.com now`)).toBe('to [email] now');
  });
});

describe('scrubBreadcrumb', () => {
  it('drops UI and console breadcrumbs at record time', () => {
    const click: SentryBreadcrumb = { category: 'ui.click', message: 'button[aria-label="7"]' };
    expect(scrubBreadcrumb(click)).toBeNull();
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
  });
});

describe('createRateLimiter', () => {
  it('passes `max` per window, drops and counts the rest, reports the count on the next one', () => {
    let t = 0;
    const limit = createRateLimiter(10, 60_000, () => t);
    const ev = (): SentryErrorEvent => ({ type: undefined });
    for (let i = 0; i < 10; i++) expect(limit(ev())).not.toBeNull();
    for (let i = 0; i < 5; i++) expect(limit(ev())).toBeNull();
    t = 60_000;
    const next = limit(ev())!;
    expect(next.tags?.['dropped_by_limit']).toBe('5');
    expect(limit(ev())!.tags?.['dropped_by_limit']).toBeUndefined();
  });
});

describe('browserInitOptions', () => {
  it('is a no-op without a DSN (local/CI builds)', () => {
    expect(browserInitOptions(undefined)).toBeNull();
    expect(browserInitOptions('')).toBeNull();
  });

  it('errors-only, sampleRate 1, no default PII, scrub + cap wired', () => {
    const o = browserInitOptions(DSN)!;
    expect(o.dsn).toBe(DSN);
    expect(o.sampleRate).toBe(1);
    expect(o.tracesSampleRate).toBe(0);
    expect(o.sendDefaultPii).toBe(false);
    expect(o.beforeBreadcrumb).toBe(scrubBreadcrumb);
    const send = o.beforeSend!;
    const hint = {};
    const first = send(syntheticEvent(), hint) as SentryErrorEvent;
    expect(JSON.stringify(first)).not.toContain(TOKEN);
    for (let i = 1; i < BROWSER_MAX_EVENTS_PER_MINUTE; i++)
      expect(send(syntheticEvent(), hint)).not.toBeNull();
    expect(send(syntheticEvent(), hint)).toBeNull();
  });
});

describe('glitchTipInitOptions (server) shares the scrub', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the same scrub on the server path', () => {
    vi.stubEnv('GLITCHTIP_DSN', DSN);
    const o = glitchTipInitOptions()!;
    expect(o.beforeSend).toBe(scrubEvent);
    expect(o.sendDefaultPii).toBe(false);
  });
});
