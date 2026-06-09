/**
 * Unit tests for the Entra ID sign-in authorization gate (ADR-0016).
 *
 * The gate decides whether an Entra-authenticated user is allowed
 * into DR3-Vision. The IdP has already authenticated "is this person
 * a member of the tenant?"; the gate authorizes "is this person an
 * active manager or admin in our DB?"
 *
 * These are pure unit tests — Prisma, `next/headers`, and the Auth.js
 * machinery are all mocked. The test is hermetic and runs in the
 * default `node` vitest environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock @/lib/prisma BEFORE importing @/lib/auth ──────────────────
// `auth.ts` imports `prisma` at module load and the NextAuth(...) call
// would attempt a real client construction otherwise.

const findUniqueMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: vi.fn(),
    },
  },
}));

// `auth.ts` imports `cookies()` for the locale-mirror helper. The
// gate evaluator never touches cookies but the module-load path does.
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
  })),
}));

// Stub the NextAuth factory so importing `auth.ts` doesn't try to
// build a real OAuth client. We only need `evaluateEntraSignIn` for
// these tests — the factory's return shape is irrelevant.
vi.mock('next-auth', () => ({
  default: () => ({
    auth: vi.fn(),
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// The provider modules are loaded for their side-effect-free factory
// functions; stub them so module load doesn't reach into Auth.js
// internals during the test.
vi.mock('next-auth/providers/credentials', () => ({
  default: (config: unknown) => config,
}));

vi.mock('next-auth/providers/microsoft-entra-id', () => ({
  default: (config: unknown) => config,
}));

// Spy on the observability logger so we can assert denied sign-ins are logged
// with the attempted email + reason (the diagnostic that was missing when
// janette.tomas@ couldn't sign in — 2026-06-09).
vi.mock('@/lib/observability/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Now safe to import the SUT.
import { evaluateEntraSignIn } from '@/lib/auth';
import { log } from '@/lib/observability/logger';

interface UserRow {
  id: string;
  email: string | null;
  name: string;
  role: 'operator' | 'manager' | 'admin';
  primary_site_id: string | null;
  is_active: boolean;
  deleted_at: Date | null;
}

const baseUser: UserRow = {
  id: 'u-1',
  email: 'manager@svdp.us',
  name: 'Managerly McManager',
  role: 'manager',
  primary_site_id: 'site-eugene',
  is_active: true,
  deleted_at: null,
};

beforeEach(() => {
  findUniqueMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('evaluateEntraSignIn — Entra sign-in authorization gate', () => {
  it('allows an existing active manager', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...baseUser, role: 'manager' });

    const result = await evaluateEntraSignIn({ email: 'manager@svdp.us' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.role).toBe('manager');
      expect(result.user.id).toBe('u-1');
    }
    // Email comparison is case-insensitive — verify the lookup was
    // lowercased before hitting Prisma.
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'manager@svdp.us' } }),
    );
  });

  it('allows an existing active admin', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...baseUser, role: 'admin' });

    const result = await evaluateEntraSignIn({ email: 'admin@svdp.us' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.role).toBe('admin');
  });

  it('lowercases the IdP-supplied email before lookup', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...baseUser });

    await evaluateEntraSignIn({ email: '  Manager@SVdP.US  ' });

    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'manager@svdp.us' } }),
    );
  });

  it('denies a user whose role is operator (operators use PIN, not SSO)', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...baseUser, role: 'operator' });

    const result = await evaluateEntraSignIn({ email: 'op@svdp.us' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong_role');
  });

  it('denies an inactive user', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...baseUser, is_active: false });

    const result = await evaluateEntraSignIn({ email: 'manager@svdp.us' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('inactive');
  });

  it('denies a soft-deleted user', async () => {
    findUniqueMock.mockResolvedValueOnce({
      ...baseUser,
      deleted_at: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await evaluateEntraSignIn({ email: 'manager@svdp.us' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('deleted');
  });

  it('denies an unknown email (no matching user row)', async () => {
    findUniqueMock.mockResolvedValueOnce(null);

    const result = await evaluateEntraSignIn({ email: 'stranger@svdp.us' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  it('denies when the IdP profile carries no email and no preferred_username', async () => {
    const result = await evaluateEntraSignIn({});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_email');
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('denies a pin-only operator account that has no email row at all', async () => {
    // A pin-only operator has email=null in the users table. Even
    // if some IdP magic produced a sign-in attempt with their name
    // string, the gate should miss because we look up by email.
    findUniqueMock.mockResolvedValueOnce(null);

    const result = await evaluateEntraSignIn({ email: 'pin-only-op@svdp.us' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});

describe('evaluateEntraSignIn — denial logging (observability)', () => {
  it('logs a structured warning with the attempted (lowercased) email + reason on an unknown denial', async () => {
    findUniqueMock.mockResolvedValueOnce(null);

    await evaluateEntraSignIn({ email: 'Janette.Tomas@SVdP.us' });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'entra_signin_denied',
        email: 'janette.tomas@svdp.us',
        reason: 'unknown',
      }),
      expect.any(String),
    );
  });

  it('logs the reason for a wrong_role denial', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...baseUser, role: 'operator' });

    await evaluateEntraSignIn({ email: 'op@svdp.us' });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'entra_signin_denied', reason: 'wrong_role' }),
      expect.any(String),
    );
  });

  it('logs no_email denials with a null email (nothing was presented)', async () => {
    await evaluateEntraSignIn({});

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'entra_signin_denied', email: null, reason: 'no_email' }),
      expect.any(String),
    );
  });

  it('does NOT log a denial warning on a successful sign-in', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...baseUser });

    await evaluateEntraSignIn({ email: 'manager@svdp.us' });

    expect(log.warn).not.toHaveBeenCalled();
  });
});
