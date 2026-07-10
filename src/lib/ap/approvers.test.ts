// ADR-0046 §3 amendment (handoff §1.6a/b) — the AP approver ROSTER as data:
// expiry-aware resolution, roster-membership permission (admin OR active
// approver, single-site managers included), and the requireApApprover guard.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApApprover,
  type FakeDb,
  type FakeUser,
} from './__testutils__/fake-prisma';

interface MockSession {
  user?: {
    id: string;
    role: 'operator' | 'manager' | 'admin';
    primary_site_id: string | null;
    all_sites: boolean;
  };
}
let mockSession: MockSession | null = null;

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

import {
  activeApproverUserIds,
  apApproverEmails,
  canActOnApRequest,
  isActiveApprover,
  requireApApprover,
} from './approvers';

const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 3_600_000);

const users: FakeUser[] = [
  {
    id: 'u-morena',
    name: 'Morena',
    email: 'morena@svdp.us',
    role: 'manager',
    all_sites: true,
    is_active: true,
  },
  {
    id: 'u-rick',
    name: 'Rick',
    email: 'rick@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
  },
  {
    id: 'u-kelsey',
    name: 'Kelsey',
    email: 'kelsey@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
  },
  {
    id: 'u-noemail',
    name: 'NoEmail',
    email: null,
    role: 'manager',
    all_sites: false,
    is_active: true,
  },
  {
    id: 'u-inactive',
    name: 'Gone',
    email: 'gone@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: false,
  },
];

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

beforeEach(() => {
  mockSession = null;
});

describe('activeApproverUserIds / apApproverEmails — expiry-aware', () => {
  const approvers: FakeApApprover[] = [
    { id: 'a1', user_id: 'u-morena', active_until: null, created_by: null }, // permanent
    { id: 'a2', user_id: 'u-rick', active_until: FUTURE, created_by: null }, // active
    { id: 'a3', user_id: 'u-kelsey', active_until: PAST, created_by: null }, // EXPIRED
  ];

  it('excludes expired approvers from the active id set', async () => {
    const ids = (await activeApproverUserIds(fp(newFakeDb({ approvers })))).sort();
    expect(ids).toEqual(['u-morena', 'u-rick']);
  });

  it('resolves active roster ids to active users with an email (expired + null-email + inactive excluded)', async () => {
    const db = newFakeDb({
      users,
      approvers: [
        ...approvers,
        { id: 'a4', user_id: 'u-noemail', active_until: null, created_by: null },
        { id: 'a5', user_id: 'u-inactive', active_until: null, created_by: null },
      ],
    });
    expect((await apApproverEmails(fp(db))).sort()).toEqual(['morena@svdp.us', 'rick@svdp.us']);
  });

  it('returns no emails when the roster is empty', async () => {
    expect(await apApproverEmails(fp(newFakeDb({ users })))).toEqual([]);
  });
});

describe('isActiveApprover / canActOnApRequest', () => {
  const approvers: FakeApApprover[] = [
    { id: 'a1', user_id: 'u-rick', active_until: FUTURE, created_by: null },
    { id: 'a2', user_id: 'u-kelsey', active_until: PAST, created_by: null },
  ];

  it('isActiveApprover: true for active, false for expired, false for non-approver', async () => {
    const p = fp(newFakeDb({ approvers }));
    expect(await isActiveApprover(p, 'u-rick')).toBe(true);
    expect(await isActiveApprover(p, 'u-kelsey')).toBe(false);
    expect(await isActiveApprover(p, 'u-morena')).toBe(false);
  });

  it('canActOnApRequest: admin passes without a roster row; active approver passes; other manager rejected', async () => {
    const p = fp(newFakeDb({ approvers }));
    expect(await canActOnApRequest({ role: 'admin', userId: 'u-bill' }, p)).toBe(true);
    expect(await canActOnApRequest({ role: 'manager', userId: 'u-rick' }, p)).toBe(true);
    expect(await canActOnApRequest({ role: 'manager', userId: 'u-morena' }, p)).toBe(false);
    expect(await canActOnApRequest({ role: 'operator', userId: 'u-rick' }, p)).toBe(true); // roster membership, not role
  });

  // The AP queue page (src/app/dashboard/ops/ap/page.tsx) gates on THIS helper. The
  // pre-amendment page gated on hasOrgReach (admin OR all_sites) — locking single-
  // site roster approvers out and letting non-roster all_sites managers in. Lock the
  // corrected contract: access = admin OR active roster member, all_sites irrelevant.
  it('page-gate parity: access is roster membership, NOT org reach / all_sites', async () => {
    const p = fp(newFakeDb({ approvers }));
    // Rick is single-site (no all_sites) but on the roster → allowed (hasOrgReach
    // would have LOCKED HIM OUT of the queue).
    expect(await canActOnApRequest({ role: 'manager', userId: 'u-rick' }, p)).toBe(true);
    // A manager with org reach but no roster row → denied (hasOrgReach would have
    // let them IN). all_sites is not even an input to this gate.
    expect(await canActOnApRequest({ role: 'manager', userId: 'u-morena' }, p)).toBe(false);
  });
});

describe('requireApApprover — guard', () => {
  const approvers: FakeApApprover[] = [
    { id: 'a1', user_id: 'u-rick', active_until: null, created_by: null },
  ];

  it('throws 401 when unauthenticated', async () => {
    mockSession = null;
    await expect(requireApApprover(fp(newFakeDb({ approvers })))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('admin passes (no roster row required)', async () => {
    mockSession = { user: { id: 'u-bill', role: 'admin', primary_site_id: null, all_sites: true } };
    const id = await requireApApprover(fp(newFakeDb({ approvers })));
    expect(id.userId).toBe('u-bill');
  });

  it('single-site manager who is a roster approver passes (no all_sites needed)', async () => {
    mockSession = {
      user: { id: 'u-rick', role: 'manager', primary_site_id: 'site-eug', all_sites: false },
    };
    const id = await requireApApprover(fp(newFakeDb({ approvers })));
    expect(id.userId).toBe('u-rick');
  });

  it('a manager who is NOT a roster approver is rejected 403', async () => {
    mockSession = {
      user: { id: 'u-nobody', role: 'manager', primary_site_id: 'site-eug', all_sites: true },
    };
    await expect(requireApApprover(fp(newFakeDb({ approvers })))).rejects.toMatchObject({
      status: 403,
    });
  });
});
