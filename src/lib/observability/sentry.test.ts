// ADR-0022 Amendment 1 — the GlitchTip scrubbing policy shared by the browser
// (floor tablets) and server inits. Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserInitOptions,
  glitchTipInitOptions,
  scrubBreadcrumb,
  scrubEvent,
  type SentryBreadcrumb,
  type SentryErrorEvent,
} from '@/lib/observability/sentry';

const DSN = 'https://testkey@errors.barnardhq.com/26';

function syntheticEvent(): SentryErrorEvent {
  return {
    type: undefined,
    message: 'synthetic failure',
    tags: { site: 'woodland' },
    user: {
      id: 'u-test-1',
      username: 'Test Operator',
      email: 'op@example.test',
      ip_address: '10.0.0.9',
    },
    request: {
      url: 'https://dr3-vision.svdp.us/operator/pin?name=Test%20Operator&pin=1234',
      query_string: 'name=Test%20Operator&pin=1234',
      data: '{"pin":"1234","name":"Test Operator"}',
      cookies: { session: 'synthetic' },
      headers: { authorization: 'Bearer synthetic', cookie: 'a=b', 'user-agent': 'iPad' },
    },
    breadcrumbs: [
      { category: 'ui.click', message: 'button.keypad-digit[aria-label="1"]' },
      { category: 'ui.input', message: 'input[name="pin"]' },
      { category: 'console', message: 'Signed in as Test Operator' },
      {
        category: 'fetch',
        data: { method: 'POST', url: '/api/auth/pin?operator=Test%20Operator', status_code: 401 },
      },
      { category: 'navigation', data: { from: '/operator?x=1', to: '/operator/loads?who=Test' } },
    ],
  };
}

describe('scrubEvent', () => {
  it('drops a PIN-tagged event entirely', () => {
    const e = syntheticEvent();
    e.tags = { has_pin: true };
    expect(scrubEvent(e)).toBeNull();
  });

  it('removes request bodies, cookies, auth headers and query strings', () => {
    const out = scrubEvent(syntheticEvent())!;
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.url).toBe('https://dr3-vision.svdp.us/operator/pin');
    expect(out.request?.headers).toEqual({ 'user-agent': 'iPad' });
  });

  it('keeps only the opaque user id — never a name, email or IP', () => {
    expect(scrubEvent(syntheticEvent())!.user).toEqual({ id: 'u-test-1' });
    const anon = syntheticEvent();
    anon.user = { username: 'Test Operator' };
    expect(scrubEvent(anon)!.user).toBeUndefined();
  });

  it('strips keypad/console breadcrumbs and URL query strings from the rest', () => {
    const out = scrubEvent(syntheticEvent())!;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('1234');
    expect(serialized).not.toContain('Test Operator');
    expect(serialized).not.toContain('Test%20Operator');
    expect(out.breadcrumbs?.map((b) => b.category)).toEqual(['fetch', 'navigation']);
    expect(out.breadcrumbs?.[0]?.data).toEqual({
      method: 'POST',
      url: '/api/auth/pin',
      status_code: 401,
    });
    expect(out.breadcrumbs?.[1]?.data).toEqual({ from: '/operator', to: '/operator/loads' });
  });
});

describe('scrubBreadcrumb', () => {
  it('drops UI and console breadcrumbs at record time', () => {
    const click: SentryBreadcrumb = { category: 'ui.click', message: 'button[aria-label="7"]' };
    expect(scrubBreadcrumb(click)).toBeNull();
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
  });
});

describe('browserInitOptions', () => {
  it('is a no-op without a DSN (local/CI builds)', () => {
    expect(browserInitOptions(undefined)).toBeNull();
    expect(browserInitOptions('')).toBeNull();
  });

  it('errors-only, no default PII, and wires both scrub hooks', () => {
    const o = browserInitOptions(DSN)!;
    expect(o.dsn).toBe(DSN);
    expect(o.tracesSampleRate).toBe(0);
    expect(o.sendDefaultPii).toBe(false);
    expect(o.beforeSend).toBe(scrubEvent);
    expect(o.beforeBreadcrumb).toBe(scrubBreadcrumb);
  });
});

describe('glitchTipInitOptions (server) shares the scrub', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('scrubs request bodies on the server path too', () => {
    vi.stubEnv('GLITCHTIP_DSN', DSN);
    const o = glitchTipInitOptions()!;
    expect(o.beforeSend).toBe(scrubEvent);
    expect(o.sendDefaultPii).toBe(false);
  });
});
