/**
 * Operator name-picker query (ADR-0061 folded fix).
 *
 * A soft-deleted operator (`deleted_at` set) can still be `is_active`, so
 * without an explicit `deleted_at: null` filter it appears in the picker,
 * passes the PIN, then gets bounced by the revocation kill-switch (empty
 * session) — a dead end. This asserts the picker query excludes them.
 */

import { describe, expect, it, vi } from 'vitest';

const findManyMock = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn().mockResolvedValue({ id: 'site-1', code: 'eugene', name: 'Eugene' }),
    },
    user: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

vi.mock('@/i18n/get-locale', () => ({ getLocale: vi.fn().mockResolvedValue('en') }));

import OperatorSitePage from './page';

describe('operator name-picker query', () => {
  it('filters out soft-deleted operators (deleted_at: null) while keeping is_active', async () => {
    await OperatorSitePage({ params: Promise.resolve({ site: 'eugene' }) });

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const arg = findManyMock.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(arg.where).toMatchObject({
      role: 'operator',
      is_active: true,
      deleted_at: null,
      primary_site_id: 'site-1',
    });
  });
});
