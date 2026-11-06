/**
 * ADR-0072 Am.2 — a role or site change voids the manager↔floor PIN link.
 *
 * Hermetic: Prisma + pin-service mocked. Captures what `updateUser` hands to
 * `tx.user.update` and asserts the link is cleared in BOTH directions (the
 * account's own `floor_user`, and every account linking to it) with an audit
 * row each, and left alone on an unrelated edit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pin-service', () => ({ setPin: vi.fn() }));

const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
const audits: { row_id: string; before: unknown; after: unknown }[] = [];
let inbound: { id: string }[] = [];

const row = {
  id: 'op-1',
  email: null as string | null,
  name: 'Floor Person',
  role: 'operator',
  locale: 'en',
  primary_site_id: 'site-a',
  processor_role: null,
  is_active: true,
  all_sites: false,
  can_manage_rates: false,
  can_view_billing_verify: false,
  pin_hash: 'x',
  is_super_admin: false,
  last_login_at: null,
  created_at: new Date('2026-11-01T00:00:00Z'),
  updated_at: new Date('2026-11-01T00:00:00Z'),
  deleted_at: null,
  floor_user_id: null as string | null,
};
const existing = { row: { ...row } };
const withSite = (r: typeof row) => ({ ...r, primary_site: { code: 'woodland' } });

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
        where.email ? null : withSite(existing.row),
      ),
    },
    site: { findUnique: vi.fn(async () => ({ id: 'site-b' })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        user: {
          update: vi.fn(
            async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
              updates.push({ where, data });
              return withSite({ ...existing.row, ...(data as Partial<typeof row>) });
            },
          ),
          findMany: vi.fn(async () => inbound),
        },
        auditLog: {
          create: vi.fn(
            async ({ data }: { data: { row_id: string; before: unknown; after: unknown } }) => {
              audits.push(data);
              return {};
            },
          ),
        },
      }),
    ),
  },
}));

import { updateUser } from '@/lib/admin-users';

const actor = { actorUserId: 'admin-1', ip: null, userAgent: null };

beforeEach(() => {
  updates.length = 0;
  audits.length = 0;
  inbound = [];
  existing.row = { ...row };
});
afterEach(() => vi.clearAllMocks());

describe('ADR-0072 Am.2 — floor-PIN link is voided by a role/site change', () => {
  it('disconnects the account’s own link when its SITE changes', async () => {
    existing.row = { ...row, role: 'manager', email: 'm@svdp.us', floor_user_id: 'op-9' };
    const r = await updateUser('op-1', { primary_site_id: 'site-b' }, actor);
    expect(r.ok).toBe(true);
    expect(updates[0]!.data['floor_user']).toEqual({ disconnect: true });
  });

  it('disconnects the account’s own link when its ROLE changes', async () => {
    existing.row = { ...row, role: 'manager', email: 'm@svdp.us', floor_user_id: 'op-9' };
    await updateUser('op-1', { role: 'admin' }, actor);
    expect(updates[0]!.data['floor_user']).toEqual({ disconnect: true });
  });

  it('clears every INBOUND link (managers pointing at this operator) and audits each', async () => {
    inbound = [{ id: 'mgr-1' }, { id: 'mgr-2' }];
    await updateUser('op-1', { primary_site_id: 'site-b' }, actor);
    const cleared = updates.filter((u) => u.data['floor_user_id'] === null).map((u) => u.where.id);
    expect(cleared).toEqual(['mgr-1', 'mgr-2']);
    const auditedRows = audits.map((a) => a.row_id);
    expect(auditedRows).toEqual(expect.arrayContaining(['mgr-1', 'mgr-2']));
  });

  it('leaves links alone on an unrelated edit (name only)', async () => {
    existing.row = { ...row, role: 'manager', email: 'm@svdp.us', floor_user_id: 'op-9' };
    inbound = [{ id: 'mgr-1' }];
    await updateUser('op-1', { name: 'Renamed' }, actor);
    expect(updates).toHaveLength(1);
    expect('floor_user' in updates[0]!.data).toBe(false);
    expect(audits).toHaveLength(1);
  });

  it('leaves links alone on a no-op same-role / same-site PATCH', async () => {
    existing.row = { ...row, floor_user_id: 'op-9' };
    await updateUser('op-1', { role: 'operator', primary_site_id: 'site-a' }, actor);
    expect('floor_user' in updates[0]!.data).toBe(false);
  });
});
