/**
 * ADR-0053 D2 — session revocation kill-switch: bump-on-change.
 *
 * Verifies the admin user-mutation paths set `sessions_invalidated_at` in the
 * SAME Prisma update as the audited mutation whenever a token-cached auth claim
 * changes (role / all_sites) or the account is deactivated — but NOT on an
 * unrelated edit (name-only). This is the write side of the kill-switch; the
 * jwt callback (auth.config) is the read/enforce side.
 *
 * Hermetic: Prisma + pin-service are mocked. We capture the `data` object
 * handed to `tx.user.update` and assert on the presence/shape of the bump.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pin-service', () => ({ setPin: vi.fn() }));

// The `data` object each transaction update receives, newest last.
const capturedUpdateData: Record<string, unknown>[] = [];

interface Row {
  id: string;
  email: string | null;
  name: string;
  role: 'operator' | 'manager' | 'admin';
  locale: 'en' | 'es' | 'ur';
  primary_site_id: string | null;
  processor_role: string | null;
  is_active: boolean;
  all_sites: boolean;
  can_manage_rates: boolean;
  can_view_billing_verify: boolean;
  pin_hash: string | null;
  is_super_admin: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const existing: { row: Row } = { row: null as unknown as Row };
const withSite = (r: Row) => ({ ...r, primary_site: { code: 'eugene' } });

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        // email-dup lookups return null (no collision); id lookups return existing.
        if (where.email) return null;
        return withSite(existing.row);
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        capturedUpdateData.push(data);
        return withSite({ ...existing.row, ...(data as Partial<Row>) });
      }),
    },
    site: { findUnique: vi.fn(async () => ({ id: 'site-eugene' })) },
    $transaction: vi.fn(
      async (fn: (tx: unknown) => unknown) =>
        await fn({
          user: {
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
              capturedUpdateData.push(data);
              return withSite({ ...existing.row, ...(data as Partial<Row>) });
            }),
          },
          auditLog: { create: vi.fn(async () => ({})) },
        }),
    ),
  },
}));

import { updateUser, deactivateUser } from '@/lib/admin-users';

const actor = { actorUserId: 'admin-1', ip: null, userAgent: null };

function baseManager(): Row {
  const now = new Date('2026-07-16T00:00:00Z');
  return {
    id: 'u-1',
    email: 'manager@svdp.us',
    name: 'Managerly',
    role: 'manager',
    locale: 'en',
    primary_site_id: 'site-eugene',
    processor_role: null,
    is_active: true,
    all_sites: false,
    can_manage_rates: false,
    can_view_billing_verify: false,
    pin_hash: null,
    is_super_admin: false,
    last_login_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

const lastUpdate = () => capturedUpdateData[capturedUpdateData.length - 1]!;

beforeEach(() => {
  capturedUpdateData.length = 0;
  existing.row = baseManager();
});
afterEach(() => vi.clearAllMocks());

describe('ADR-0053 D2 — bump-on-change in admin-users', () => {
  it('sets sessions_invalidated_at on a ROLE change (manager → admin)', async () => {
    const r = await updateUser('u-1', { role: 'admin' }, actor);
    expect(r.ok).toBe(true);
    expect(lastUpdate()['role']).toBe('admin');
    expect(lastUpdate()['sessions_invalidated_at']).toBeInstanceOf(Date);
  });

  it('sets sessions_invalidated_at on an ALL_SITES change (false → true)', async () => {
    const r = await updateUser('u-1', { all_sites: true }, actor);
    expect(r.ok).toBe(true);
    expect(lastUpdate()['all_sites']).toBe(true);
    expect(lastUpdate()['sessions_invalidated_at']).toBeInstanceOf(Date);
  });

  it('sets sessions_invalidated_at on deactivation (the fired-employee path)', async () => {
    const r = await deactivateUser('u-1', actor);
    expect(r.ok).toBe(true);
    expect(lastUpdate()['is_active']).toBe(false);
    expect(lastUpdate()['deleted_at']).toBeInstanceOf(Date);
    expect(lastUpdate()['sessions_invalidated_at']).toBeInstanceOf(Date);
  });

  it('does NOT bump on a name-only edit', async () => {
    const r = await updateUser('u-1', { name: 'Renamed' }, actor);
    expect(r.ok).toBe(true);
    expect(lastUpdate()['name']).toBe('Renamed');
    expect('sessions_invalidated_at' in lastUpdate()).toBe(false);
  });

  it('does NOT bump on a no-op same-role PATCH', async () => {
    const r = await updateUser('u-1', { role: 'manager' }, actor);
    expect(r.ok).toBe(true);
    expect('sessions_invalidated_at' in lastUpdate()).toBe(false);
  });
});
