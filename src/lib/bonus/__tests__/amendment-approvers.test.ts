// ADR-0028 — Amendment approver resolution + eligibility tests.
//
// `resolveAmendmentApprover` reads the signature chain (mocked here per
// site) and maps the requester to the counterpart slot's signer. Patrick /
// any non-chain user is structurally forbidden. `canApproveRequest` is the
// pure eligibility predicate (requester never; counterpart always; admin
// always; auto-override actor only when bill_pinged_at is set).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// ── signature-chain double ───────────────────────────────────────────
interface FakeChain {
  facility_signer_user_id: string;
  facility_override_actor_user_ids: string[];
  ops_signer_user_id: string;
  ops_override_actor_user_ids: string[];
  auto_override_actor_user_id: string;
}

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

const WOODLAND_CHAIN: FakeChain = {
  facility_signer_user_id: 'janette',
  facility_override_actor_user_ids: ['bill', 'morena'],
  ops_signer_user_id: 'morena',
  ops_override_actor_user_ids: ['bill'],
  auto_override_actor_user_id: 'bill',
};
const EUGENE_CHAIN: FakeChain = {
  facility_signer_user_id: 'rick',
  facility_override_actor_user_ids: ['bill'],
  ops_signer_user_id: 'kelsey',
  ops_override_actor_user_ids: ['bill'],
  auto_override_actor_user_id: 'bill',
};

const getSignatureChain = vi.fn<(siteId: string) => Promise<FakeChain>>(async (siteId) => {
  if (siteId === WOODLAND) return WOODLAND_CHAIN;
  if (siteId === EUGENE) return EUGENE_CHAIN;
  throw new Error(`no chain for ${siteId}`);
});
vi.mock('@/lib/bonus/signature-chain', () => ({
  getSignatureChain: (siteId: string) => getSignatureChain(siteId),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  resolveAmendmentApprover,
  canApproveRequest,
  AmendmentWorkflowForbiddenError,
} from '../amendment-approvers';

const db = {} as unknown as PrismaClient;

beforeEach(() => {
  getSignatureChain.mockClear();
});

describe('resolveAmendmentApprover', () => {
  it('Janette (Woodland facility) → Morena (ops counterpart)', async () => {
    const r = await resolveAmendmentApprover(db, WOODLAND, 'janette');
    expect(r.expectedApproverUserId).toBe('morena');
    expect(r.pingBillUserId).toBe('bill');
  });

  it('Morena (Woodland ops) → Janette (facility counterpart)', async () => {
    const r = await resolveAmendmentApprover(db, WOODLAND, 'morena');
    expect(r.expectedApproverUserId).toBe('janette');
    expect(r.pingBillUserId).toBe('bill');
  });

  it('Rick (Eugene facility) → Kelsey (ops counterpart)', async () => {
    const r = await resolveAmendmentApprover(db, EUGENE, 'rick');
    expect(r.expectedApproverUserId).toBe('kelsey');
  });

  it('Kelsey (Eugene ops) → Rick (facility counterpart)', async () => {
    const r = await resolveAmendmentApprover(db, EUGENE, 'kelsey');
    expect(r.expectedApproverUserId).toBe('rick');
  });

  it('Patrick (Eugene Lead processor, not a chain signer) → forbidden', async () => {
    await expect(resolveAmendmentApprover(db, EUGENE, 'patrick')).rejects.toBeInstanceOf(
      AmendmentWorkflowForbiddenError,
    );
    await expect(resolveAmendmentApprover(db, EUGENE, 'patrick')).rejects.toMatchObject({
      forbiddenReason: 'patrick_or_other_non_chain_manager',
      status: 403,
    });
  });

  it('a random non-chain user → forbidden (same reason)', async () => {
    await expect(resolveAmendmentApprover(db, WOODLAND, 'stranger')).rejects.toMatchObject({
      forbiddenReason: 'patrick_or_other_non_chain_manager',
    });
  });
});

describe('canApproveRequest', () => {
  const baseRequest = {
    requested_by_user_id: 'janette',
    expected_approver_user_id: 'morena',
    bill_pinged_at: null as Date | null,
  };
  const chain = { auto_override_actor_user_id: 'bill' };

  it('the counterpart approver → true', () => {
    expect(
      canApproveRequest({
        actorUserId: 'morena',
        request: baseRequest,
        chain,
        actorIsAdmin: false,
      }),
    ).toBe(true);
  });

  it('the requester themselves → false (even if admin)', () => {
    expect(
      canApproveRequest({
        actorUserId: 'janette',
        request: baseRequest,
        chain,
        actorIsAdmin: true,
      }),
    ).toBe(false);
  });

  it('an admin who is not the counterpart → true', () => {
    expect(
      canApproveRequest({
        actorUserId: 'someadmin',
        request: baseRequest,
        chain,
        actorIsAdmin: true,
      }),
    ).toBe(true);
  });

  it('the auto-override actor (Bill) with bill_pinged_at set → true', () => {
    expect(
      canApproveRequest({
        actorUserId: 'bill',
        request: { ...baseRequest, bill_pinged_at: new Date() },
        chain,
        actorIsAdmin: false,
      }),
    ).toBe(true);
  });

  it('the auto-override actor (Bill) with bill_pinged_at null → false', () => {
    expect(
      canApproveRequest({
        actorUserId: 'bill',
        request: { ...baseRequest, bill_pinged_at: null },
        chain,
        actorIsAdmin: false,
      }),
    ).toBe(false);
  });

  it('a random non-admin, non-counterpart, non-pinged actor → false', () => {
    expect(
      canApproveRequest({
        actorUserId: 'stranger',
        request: baseRequest,
        chain,
        actorIsAdmin: false,
      }),
    ).toBe(false);
  });
});
