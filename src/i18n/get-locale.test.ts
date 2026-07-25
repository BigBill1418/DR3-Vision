/**
 * Locale resolution precedence (ADR-0061 D-4 — session-first).
 *
 * The load-bearing behavior: on a SHARED floor iPad, the signed-in operator's
 * stored `users.locale` must outrank the device-global `dr3_locale` cookie, so
 * one person's pre-auth pick can never pin or mask another operator's language.
 * The cookie is only a pre-auth hint for the sign-in screens (no session yet).
 *
 * Prisma, `next/headers`, and `@/lib/auth` are mocked — pure unit test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: (name: string) => cookieGet(name) })),
}));

const authMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: (...a: unknown[]) => authMock(...a) }));

const findUniqueMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUniqueMock(...a) } },
}));

import { resolveLocale, getLocale } from './get-locale';

function setCookie(value: string | undefined) {
  cookieGet.mockImplementation((name: string) =>
    name === 'dr3_locale' && value ? { value } : undefined,
  );
}
function setSessionLocale(locale: string | null) {
  if (locale === null) {
    authMock.mockResolvedValue(null);
    return;
  }
  authMock.mockResolvedValue({ user: { id: 'u-1' } });
  findUniqueMock.mockResolvedValue({ locale });
}

beforeEach(() => {
  cookieGet.mockReset();
  authMock.mockReset();
  findUniqueMock.mockReset();
  setCookie(undefined);
  authMock.mockResolvedValue(null);
});
afterEach(() => vi.clearAllMocks());

describe('resolveLocale — precedence', () => {
  it('?lang= query wins over everything', async () => {
    setSessionLocale('ur');
    setCookie('es');
    const ctx = await resolveLocale({ lang: 'es' });
    expect(ctx).toEqual({ locale: 'es', source: 'query' });
  });

  it('ignores an invalid ?lang= and falls through', async () => {
    setSessionLocale(null);
    setCookie('ur');
    const ctx = await resolveLocale({ lang: 'de' });
    expect(ctx).toEqual({ locale: 'ur', source: 'cookie' });
  });

  it('D-4: signed-in operator locale BEATS a conflicting device cookie', async () => {
    setSessionLocale('es');
    setCookie('ur'); // stale device cookie from a previous operator
    const ctx = await resolveLocale();
    expect(ctx).toEqual({ locale: 'es', source: 'session' });
  });

  it('uses the cookie pre-auth (no session) so sign-in screens localize', async () => {
    setSessionLocale(null);
    setCookie('es');
    const ctx = await resolveLocale();
    expect(ctx).toEqual({ locale: 'es', source: 'cookie' });
  });

  it('falls to the default when there is no session and no cookie', async () => {
    setSessionLocale(null);
    setCookie(undefined);
    const ctx = await resolveLocale();
    expect(ctx).toEqual({ locale: 'en', source: 'default' });
  });

  it('falls back to the cookie when the session user has an invalid stored locale', async () => {
    authMock.mockResolvedValue({ user: { id: 'u-1' } });
    findUniqueMock.mockResolvedValue({ locale: 'zz' });
    setCookie('ur');
    const ctx = await resolveLocale();
    expect(ctx).toEqual({ locale: 'ur', source: 'cookie' });
  });

  it('never throws if auth() blows up outside a request context', async () => {
    authMock.mockRejectedValue(new Error('no request context'));
    setCookie('es');
    const ctx = await resolveLocale();
    expect(ctx).toEqual({ locale: 'es', source: 'cookie' });
  });

  it('getLocale() returns just the resolved code', async () => {
    setSessionLocale('ur');
    expect(await getLocale()).toBe('ur');
  });
});
