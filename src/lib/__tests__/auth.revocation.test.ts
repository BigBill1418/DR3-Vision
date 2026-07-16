/**
 * ADR-0053 D2 — session revocation kill-switch: the Node-runtime checker.
 *
 * `checkTokenRevocation(userId, tokenIatSeconds)` is what the jwt callback runs
 * on every non-initial pass in the Node runtime. It is the authoritative
 * revocation decision: a deactivated / soft-deleted / vanished user is revoked
 * even without a switch bump, and a token whose issued-at predates a
 * `sessions_invalidated_at` bump is revoked (force re-auth).
 *
 * Pure unit tests — Prisma, next/headers, and the NextAuth factory are mocked
 * exactly as in `auth.signin-gate.test.ts`, so importing `@/lib/auth` is
 * hermetic and runs in the default `node` vitest environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUniqueMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: vi.fn(),
    },
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

vi.mock('next-auth', () => ({
  default: () => ({
    auth: vi.fn(),
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('next-auth/providers/credentials', () => ({ default: (c: unknown) => c }));
vi.mock('next-auth/providers/microsoft-entra-id', () => ({ default: (c: unknown) => c }));
vi.mock('@/lib/observability/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkTokenRevocation } from '@/lib/auth';

// A fixed sign-in instant for the token under test: 2026-07-16T00:00:00Z.
const TOKEN_IAT_S = Math.floor(Date.UTC(2026, 6, 16, 0, 0, 0) / 1000);

interface Row {
  is_active: boolean;
  deleted_at: Date | null;
  sessions_invalidated_at: Date | null;
}
const activeRow: Row = { is_active: true, deleted_at: null, sessions_invalidated_at: null };

beforeEach(() => findUniqueMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe('checkTokenRevocation — ADR-0053 D2 kill-switch', () => {
  it('passes an unaffected active user with no switch bump', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...activeRow });
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('ok');
  });

  it('reads a single narrow, PK-indexed select', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...activeRow });
    await checkTokenRevocation('u-1', TOKEN_IAT_S);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      select: { is_active: true, deleted_at: true, sessions_invalidated_at: true },
    });
  });

  it('revokes a deactivated user even with NO switch bump', async () => {
    findUniqueMock.mockResolvedValueOnce({ ...activeRow, is_active: false });
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('revoke');
  });

  it('revokes a soft-deleted user even with NO switch bump', async () => {
    findUniqueMock.mockResolvedValueOnce({
      ...activeRow,
      deleted_at: new Date('2026-07-16T01:00:00Z'),
    });
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('revoke');
  });

  it('revokes when the user row has vanished (findUnique null) — fail closed', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('revoke');
  });

  it('revokes a token issued BEFORE a sessions_invalidated_at bump', async () => {
    // Switch bumped one hour AFTER the token was issued.
    findUniqueMock.mockResolvedValueOnce({
      ...activeRow,
      sessions_invalidated_at: new Date((TOKEN_IAT_S + 3600) * 1000),
    });
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('revoke');
  });

  it('passes a token issued AFTER the last sessions_invalidated_at bump', async () => {
    // Switch bumped one hour BEFORE the token was issued (e.g. a fresh re-auth).
    findUniqueMock.mockResolvedValueOnce({
      ...activeRow,
      sessions_invalidated_at: new Date((TOKEN_IAT_S - 3600) * 1000),
    });
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('ok');
  });

  it('does not over-revoke when the bump equals the token iat second (not strictly newer)', async () => {
    // Bump exactly at the iat boundary: getTime() == iat*1000, not `>`, so survive.
    findUniqueMock.mockResolvedValueOnce({
      ...activeRow,
      sessions_invalidated_at: new Date(TOKEN_IAT_S * 1000),
    });
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('ok');
  });

  it('revokes on the millisecond even when bump lands in the same second as iat', async () => {
    // iat is second-granular; the column is ms-precise. A bump 500ms into the
    // iat second is strictly newer than iat*1000 → revoke (fail closed).
    findUniqueMock.mockResolvedValueOnce({
      ...activeRow,
      sessions_invalidated_at: new Date(TOKEN_IAT_S * 1000 + 500),
    });
    expect(await checkTokenRevocation('u-1', TOKEN_IAT_S)).toBe('revoke');
  });
});
