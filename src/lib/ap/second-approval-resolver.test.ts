// ADR-0066 §1.4 — the shared second-approval resolver.
//
// The headline test is `THE INVARIANT` below. Its violation is what caused the
// outage: authorization accepted admin-eligibility while notification queried the
// site roster alone, so Woodland second-approvals were authorized-by-Bill and
// notifiable-by-nobody. Fail-soft then made an empty recipient set look exactly
// like a successful send, every time, for days.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeDb } from './__testutils__/fake-prisma';
import {
  resolveSecondApproval,
  canFulfillSecondApprovalByRouting,
} from './second-approval-resolver';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

// The real roster (§1.4 / §1.6). Note BILL and MORENA/JANETTE each also have an
// operator PIN account in production with NO email — modelled here because a
// name-keyed seed selected exactly those accounts and would have reproduced the
// outage. See `-op` rows.
const U = {
  janette: {
    id: 'u-jt',
    name: 'Janette Tomas',
    email: 'janette.tomas@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  morena: {
    id: 'u-mg',
    name: 'Morena Gomez',
    email: 'morena.gomez@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  kelsey: {
    id: 'u-kr',
    name: 'Kelsey Ruhland',
    email: 'kelsey.ruhland@svdp.us',
    role: 'manager' as const,
    all_sites: true,
    is_active: true,
  },
  rick: {
    id: 'u-ra',
    name: 'Rick Albritton',
    email: 'rick.albritton@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  shannon: {
    id: 'u-sr',
    name: 'Shannon Rockwell',
    email: 'shannon.rockwell@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  bill: {
    id: 'u-bb',
    name: 'Bill Barnard',
    email: 'bill.barnard@svdp.us',
    role: 'admin' as const,
    all_sites: false,
    is_active: true,
  },
  // The email-less operator PIN accounts created 2026-07-28 for the iPad rollout.
  morenaOp: {
    id: 'u-mg-op',
    name: 'Morena Gomez',
    email: null,
    role: 'operator' as const,
    all_sites: false,
    is_active: true,
  },
  billOp: {
    id: 'u-bb-op',
    name: 'Bill Barnard',
    email: null,
    role: 'operator' as const,
    all_sites: false,
    is_active: true,
  },
};

const ROUTING = [
  {
    id: 'r1',
    first_approver_id: U.janette.id,
    second_approver_id: U.morena.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'r2',
    first_approver_id: U.morena.id,
    second_approver_id: U.janette.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'r3',
    first_approver_id: U.kelsey.id,
    second_approver_id: U.morena.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'r4',
    first_approver_id: U.rick.id,
    second_approver_id: U.shannon.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'r5',
    first_approver_id: U.shannon.id,
    second_approver_id: U.rick.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'r6',
    first_approver_id: U.bill.id,
    second_approver_id: U.morena.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
];

const seed = (over: Partial<FakeDb> = {}) =>
  newFakeDb({
    users: Object.values(U),
    approvalRouting: ROUTING,
    ...over,
  });

const emails = (r: { recipients: { email: string }[] }) => r.recipients.map((x) => x.email).sort();

describe('THE INVARIANT — authorized implies notifiable', () => {
  // This is the property whose violation caused the outage.
  it('every first approver in the roster yields a NON-EMPTY recipient set', async () => {
    for (const first of [U.janette, U.morena, U.kelsey, U.rick, U.shannon, U.bill]) {
      const r = await resolveSecondApproval(fp(seed()), { firstApproverId: first.id });
      expect(r.authorizedUserIds.length).toBeGreaterThan(0);
      expect(r.recipients.length).toBeGreaterThan(0);
    }
  });

  it('holds even for an approver with NO routing row at all', async () => {
    const r = await resolveSecondApproval(fp(seed()), { firstApproverId: 'u-nobody' });
    expect(r.authorizedUserIds.length).toBeGreaterThan(0);
    expect(r.recipients.length).toBeGreaterThan(0);
    expect(r.outcome).toBe('fallback_no_routing_row');
  });

  it('THE REGRESSION: Bill first-approving is notifiable — the old path resolved EMPTY', async () => {
    // Pre-fix, `activeSecondApproversForSite(prisma,'woodland')` returned [] because
    // Bill was deliberately never given a roster row. Authorization said yes,
    // notification said nobody, fail-soft swallowed it.
    const r = await resolveSecondApproval(fp(seed()), { firstApproverId: U.bill.id });
    expect(r.recipients.length).toBeGreaterThan(0);
    expect(emails(r)).toEqual([U.morena.email]);
  });
});

describe('§1.4 routing table — person to person', () => {
  it.each([
    ['Janette', U.janette.id, U.morena.email],
    ['Morena', U.morena.id, U.janette.email],
    ['Kelsey', U.kelsey.id, U.morena.email],
    ['Rick', U.rick.id, U.shannon.email],
    ['Shannon', U.shannon.id, U.rick.email],
    ['Bill', U.bill.id, U.morena.email],
  ])('%s routes to exactly one person: %s', async (_label, firstId, expected) => {
    const r = await resolveSecondApproval(fp(seed()), { firstApproverId: firstId as string });
    expect(r.outcome).toBe('routed');
    expect(emails(r)).toEqual([expected]);
    expect(r.routedTo?.email).toBe(expected);
  });

  it('never broadcasts — exactly one recipient on the happy path', async () => {
    const r = await resolveSecondApproval(fp(seed()), { firstApproverId: U.rick.id });
    expect(r.recipients).toHaveLength(1);
  });

  it('reports no problems when the table is healthy', async () => {
    const r = await resolveSecondApproval(fp(seed()), { firstApproverId: U.janette.id });
    expect(r.problems).toEqual([]);
  });
});

describe('§7 — Shannon receives second-approval requests ONLY on Rick’s first signature', () => {
  // Bill's explicit requirement, asserted directly rather than implied by pref rows.
  it('Rick first-signing routes to Shannon', async () => {
    const r = await resolveSecondApproval(fp(seed()), { firstApproverId: U.rick.id });
    expect(emails(r)).toEqual([U.shannon.email]);
  });

  it('NOBODY ELSE first-signing ever reaches Shannon', async () => {
    for (const first of [U.janette, U.morena, U.kelsey, U.bill]) {
      const r = await resolveSecondApproval(fp(seed()), { firstApproverId: first.id });
      expect(r.recipients.some((x) => x.email === U.shannon.email)).toBe(false);
    }
  });

  it('Shannon is not reached by an unrouted approver’s admin fallback', async () => {
    const r = await resolveSecondApproval(fp(seed()), { firstApproverId: 'u-nobody' });
    expect(r.recipients.some((x) => x.email === U.shannon.email)).toBe(false);
  });
});

describe('unreachable routing targets (the seed near-miss)', () => {
  it('falls back and REPORTS when the routed peer has no email (operator PIN account)', async () => {
    // Exactly what a name-keyed seed produced: routing pointed at the email-less
    // operator account, so the table looked populated and notified nobody.
    const db = seed({
      users: [...Object.values(U)],
      approvalRouting: [
        {
          id: 'rX',
          first_approver_id: U.janette.id,
          second_approver_id: U.morenaOp.id,
          fallback_approver_id: null,
          fallback_after_hours: 24,
          active: true,
        },
      ],
    });
    const r = await resolveSecondApproval(fp(db), { firstApproverId: U.janette.id });
    expect(r.outcome).toBe('fallback_unreachable_peer');
    expect(r.recipients.length).toBeGreaterThan(0); // invariant still holds
    expect(r.problems.join(' ')).toMatch(/unreachable second approver/i);
  });

  it('falls back when the routed peer is deactivated', async () => {
    const db = seed({
      users: [
        ...Object.values(U).filter((u) => u.id !== U.morena.id),
        { ...U.morena, is_active: false },
      ],
    });
    const r = await resolveSecondApproval(fp(db), { firstApproverId: U.janette.id });
    expect(r.outcome).toBe('fallback_unreachable_peer');
    expect(emails(r)).toEqual([U.bill.email]);
  });

  it('an inactive routing row is treated as no row at all', async () => {
    const db = seed({
      approvalRouting: ROUTING.map((r) => (r.id === 'r1' ? { ...r, active: false } : r)),
    });
    const r = await resolveSecondApproval(fp(db), { firstApproverId: U.janette.id });
    expect(r.outcome).toBe('fallback_no_routing_row');
    expect(r.problems.join(' ')).toMatch(/No active ap_approval_routing row/i);
  });
});

describe('§1.5 escalation is ADDITIVE, never a transfer', () => {
  it('adds the fallback while KEEPING the original peer notifiable', async () => {
    const r = await resolveSecondApproval(fp(seed()), {
      firstApproverId: U.janette.id,
      escalated: true,
    });
    expect(r.outcome).toBe('escalated');
    expect(emails(r)).toEqual([U.bill.email, U.morena.email].sort());
    expect(r.routedTo?.email).toBe(U.morena.email); // peer still the routed target
  });

  it('keeps the peer AUTHORIZED after escalation', async () => {
    const db = seed();
    const ok = await canFulfillSecondApprovalByRouting(
      fp(db),
      { userId: U.morena.id, role: 'manager' },
      { firstApproverId: U.janette.id, escalated: true },
    );
    expect(ok).toBe(true);
  });

  it('does not duplicate a recipient who is both peer and fallback', async () => {
    const db = seed({
      approvalRouting: [
        {
          id: 'rD',
          first_approver_id: U.janette.id,
          second_approver_id: U.bill.id,
          fallback_approver_id: U.bill.id,
          fallback_after_hours: 24,
          active: true,
        },
      ],
    });
    const r = await resolveSecondApproval(fp(db), {
      firstApproverId: U.janette.id,
      escalated: true,
    });
    expect(r.recipients).toHaveLength(1);
    expect(emails(r)).toEqual([U.bill.email]);
  });
});

describe('authorization stays in lockstep with notification', () => {
  it('admin remains ALWAYS eligible (unchanged rule)', async () => {
    const ok = await canFulfillSecondApprovalByRouting(
      fp(seed()),
      { userId: U.bill.id, role: 'admin' },
      { firstApproverId: U.rick.id },
    );
    expect(ok).toBe(true);
  });

  it('the routed peer is eligible', async () => {
    const ok = await canFulfillSecondApprovalByRouting(
      fp(seed()),
      { userId: U.shannon.id, role: 'manager' },
      { firstApproverId: U.rick.id },
    );
    expect(ok).toBe(true);
  });

  it('an unrelated manager is NOT eligible', async () => {
    const ok = await canFulfillSecondApprovalByRouting(
      fp(seed()),
      { userId: U.janette.id, role: 'manager' },
      { firstApproverId: U.rick.id },
    );
    expect(ok).toBe(false);
  });

  it('everyone authorized is either an admin or appears in the recipient set', async () => {
    // The structural guarantee: no authorized non-admin is invisible to notification.
    const db = seed();
    const r = await resolveSecondApproval(fp(db), { firstApproverId: U.rick.id });
    const adminIds = new Set([U.bill.id]);
    const notifiable = new Set(r.recipients.map((x) => x.userId));
    for (const id of r.authorizedUserIds) {
      expect(adminIds.has(id) || notifiable.has(id)).toBe(true);
    }
  });
});
