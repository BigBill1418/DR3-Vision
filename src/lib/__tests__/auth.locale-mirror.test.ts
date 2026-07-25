/**
 * mirrorLocaleCookie — explicit-pick fold, shared-device-safe (ADR-0061 D-4).
 *
 * The regression this locks in: on a shared floor iPad the ambient
 * device-global `dr3_locale` cookie must NEVER be written into `users.locale`
 * on sign-in (that was the old T-008 behavior that let one manager's pick
 * corrupt every operator's stored preference). Only an EXPLICIT pre-auth pick
 * — recorded in the short-lived `dr3_locale_pick` marker — is folded, and the
 * marker is consumed so it cannot re-apply to a later operator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

// Controllable cookie store shared across the test.
const cookieJar = new Map<string, string>();
const setSpy = vi.fn((...args: unknown[]) => {
  const [name, value] = args as [string, string];
  if (value === '') cookieJar.delete(name);
  else cookieJar.set(name, value);
});
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string, ...rest: unknown[]) => setSpy(name, value, ...rest),
  })),
}));

// Module-load stubs so importing auth.ts doesn't build real Auth.js/OAuth.
vi.mock('next-auth', () => ({
  default: () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }),
}));
vi.mock('next-auth/providers/credentials', () => ({ default: (c: unknown) => c }));
vi.mock('next-auth/providers/microsoft-entra-id', () => ({ default: (c: unknown) => c }));
vi.mock('@/lib/observability/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mirrorLocaleCookie } from '@/lib/auth';

beforeEach(() => {
  cookieJar.clear();
  updateMock.mockReset();
  setSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('mirrorLocaleCookie (ADR-0061 D-4)', () => {
  it('does NOT overwrite users.locale from an ambient device cookie (no marker)', async () => {
    cookieJar.set('dr3_locale', 'ur'); // device cookie only — no explicit pick
    await mirrorLocaleCookie('op-1');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('folds an explicit pre-auth pick marker into users.locale', async () => {
    cookieJar.set('dr3_locale', 'en'); // ambient cookie present but irrelevant
    cookieJar.set('dr3_locale_pick', 'es'); // explicit pick by this operator
    await mirrorLocaleCookie('op-1');
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'op-1' }, data: { locale: 'es' } });
  });

  it('consumes (clears) the marker after folding so it cannot re-apply', async () => {
    cookieJar.set('dr3_locale_pick', 'es');
    await mirrorLocaleCookie('op-1');
    // cleared via an empty-value set
    expect(setSpy).toHaveBeenCalledWith('dr3_locale_pick', '', expect.anything());
    expect(cookieJar.has('dr3_locale_pick')).toBe(false);
  });

  it('ignores an invalid marker value', async () => {
    cookieJar.set('dr3_locale_pick', 'zz');
    await mirrorLocaleCookie('op-1');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does nothing when there is neither a marker nor a cookie', async () => {
    await mirrorLocaleCookie('op-1');
    expect(updateMock).not.toHaveBeenCalled();
  });
});
