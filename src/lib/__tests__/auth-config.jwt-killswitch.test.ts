/**
 * ADR-0053 D2 — session revocation kill-switch: jwt-callback enforcement.
 *
 * Drives the real `authConfig.callbacks.jwt` with a dependency-injected fake
 * checker (`setRevocationChecker`). Verifies:
 *   - a `revoke` verdict empties the token (mirrors idle-timeout → forces re-auth)
 *   - an `ok` verdict passes the token through untouched (bar last_seen_at)
 *   - the initial sign-in pass (user present) NEVER calls the checker
 *   - the existing idle-timeout still fires and short-circuits before the checker
 *   - with no checker registered (the edge-middleware case) the callback skips
 *     the DB read and relies on idle/absolute timeout only
 *
 * Pure unit test, default `node` environment. The Entra provider factory is
 * stubbed so importing `auth.config.ts` doesn't reach into Auth.js internals.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/providers/microsoft-entra-id', () => ({ default: (c: unknown) => c }));

import { authConfig, setRevocationChecker } from '@/lib/auth.config';
import type { JWT } from 'next-auth/jwt';

const jwt = authConfig.callbacks!.jwt!;
const NOW_S = Math.floor(Date.now() / 1000);

function activeToken(overrides: Partial<JWT> = {}): JWT {
  return {
    sub: 'u-1',
    role: 'manager',
    all_sites: false,
    is_super_admin: false,
    iat: NOW_S - 60,
    last_seen_at: NOW_S - 60,
    ...overrides,
  } as JWT;
}

// Auth.js passes these as `unknown`-ish; the callback only reads a few fields.
type JwtArgs = Parameters<typeof jwt>[0];
function call(args: Partial<JwtArgs>): ReturnType<typeof jwt> {
  return jwt({ token: activeToken(), ...args } as JwtArgs);
}

afterEach(() => {
  setRevocationChecker(null);
  vi.clearAllMocks();
});

describe('jwt callback — ADR-0053 D2 revocation enforcement', () => {
  it('empties the token when the checker returns revoke', async () => {
    const checker = vi.fn(async () => 'revoke' as const);
    setRevocationChecker(checker);

    const out = (await call({ token: activeToken() })) as JWT;

    expect(checker).toHaveBeenCalledWith('u-1', NOW_S - 60);
    expect(out.sub).toBeUndefined();
    expect(out.role).toBeUndefined();
  });

  it('passes the token through when the checker returns ok', async () => {
    const checker = vi.fn(async () => 'ok' as const);
    setRevocationChecker(checker);

    const out = (await call({ token: activeToken() })) as JWT;

    expect(checker).toHaveBeenCalledTimes(1);
    expect(out.sub).toBe('u-1');
    expect(out.role).toBe('manager');
    // idle sliding-window still advances on a surviving token
    expect(out.last_seen_at).toBe(NOW_S);
  });

  it('does NOT call the checker on the initial sign-in pass (user present)', async () => {
    const checker = vi.fn(async () => 'revoke' as const);
    setRevocationChecker(checker);

    const user = {
      id: 'u-9',
      email: 'm@svdp.us',
      name: 'M',
      role: 'manager' as const,
      primary_site_id: 'site-eugene',
      all_sites: false,
      is_super_admin: false,
    };
    const out = (await jwt({ token: {} as JWT, user, account: null } as JwtArgs)) as JWT;

    expect(checker).not.toHaveBeenCalled();
    expect(out.sub).toBe('u-9');
    expect(out.role).toBe('manager');
  });

  it('idle-timeout still fires and short-circuits before the checker', async () => {
    const checker = vi.fn(async () => 'ok' as const);
    setRevocationChecker(checker);

    // 13h since last_seen — past the 12h manager idle cap.
    const stale = activeToken({ last_seen_at: NOW_S - 13 * 60 * 60 });
    const out = (await jwt({ token: stale } as JwtArgs)) as JWT;

    expect(checker).not.toHaveBeenCalled();
    expect(out.sub).toBeUndefined();
  });

  it('skips the DB read entirely when no checker is registered (edge middleware case)', async () => {
    // No setRevocationChecker → null. Token must survive (idle ok) with no throw.
    const out = (await call({ token: activeToken() })) as JWT;
    expect(out.sub).toBe('u-1');
    expect(out.last_seen_at).toBe(NOW_S);
  });
});
