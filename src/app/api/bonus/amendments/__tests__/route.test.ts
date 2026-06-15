// ADR-0028 — Amendment HTTP route tests.
//
// Drives the five route handlers in-process. The SERVICE layer
// (amendment-requests) is unit-tested separately (§11.2); here we assert the
// HTTP surface: the admin/Patrick gates, status-code mapping of
// AmendmentRequestError / AmendmentWorkflowForbiddenError, the site-scoped
// GET, and that approve/reject/ping fire their notifications (via spies),
// with ping-bill firing only on the FIRST ping. Boundaries mocked: access,
// the service module, the notification module (spies), and prisma user lookups.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── access gate ──────────────────────────────────────────────────────
type Ctx = { siteId: string; userId: string; isAdmin: boolean; siteName: string };
let accessCtx: Ctx;
const requireBonusAccess = vi.fn(async (): Promise<Ctx> => accessCtx);
const siteFromRequest = vi.fn(() => undefined);
vi.mock('@/lib/bonus/access', () => ({
  requireBonusAccess: () => requireBonusAccess(),
  siteFromRequest: () => siteFromRequest(),
}));

// ── service module ───────────────────────────────────────────────────
import { AmendmentRequestError } from '@/lib/bonus/amendment-requests';
import { AmendmentWorkflowForbiddenError } from '@/lib/bonus/amendment-approvers';

const submitAmendmentRequest = vi.fn();
const listPendingForApprover = vi.fn();
const approveAmendmentRequest = vi.fn();
const rejectAmendmentRequest = vi.fn();
const cancelAmendmentRequest = vi.fn();
const pingBill = vi.fn();
vi.mock('@/lib/bonus/amendment-requests', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    submitAmendmentRequest: (...a: unknown[]) => submitAmendmentRequest(...a),
    listPendingForApprover: (...a: unknown[]) => listPendingForApprover(...a),
    approveAmendmentRequest: (...a: unknown[]) => approveAmendmentRequest(...a),
    rejectAmendmentRequest: (...a: unknown[]) => rejectAmendmentRequest(...a),
    cancelAmendmentRequest: (...a: unknown[]) => cancelAmendmentRequest(...a),
    pingBill: (...a: unknown[]) => pingBill(...a),
  };
});

// ── notification spies ───────────────────────────────────────────────
const notifyAmendmentSubmitted = vi.fn(async () => {});
const notifyAmendmentApproved = vi.fn(async () => {});
const notifyAmendmentRejected = vi.fn(async () => {});
const notifyAmendmentBillPinged = vi.fn(async () => {});
const buildNotifyContext = vi.fn(async () => ({ requestId: 'amd-1' }));
vi.mock('@/lib/bonus/amendment-notifications', () => ({
  buildNotifyContext: () => buildNotifyContext(),
  notifyAmendmentSubmitted: (...a: unknown[]) => notifyAmendmentSubmitted(...(a as [])),
  notifyAmendmentApproved: (...a: unknown[]) => notifyAmendmentApproved(...(a as [])),
  notifyAmendmentRejected: (...a: unknown[]) => notifyAmendmentRejected(...(a as [])),
  notifyAmendmentBillPinged: (...a: unknown[]) => notifyAmendmentBillPinged(...(a as [])),
}));

// ── prisma user lookups (approve/reject/ping read reviewer/bill/requester) ──
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: async () => ({ name: 'Reviewer', email: 'reviewer@svdp.us' }),
      findFirst: async () => ({ email: 'bill@barnardhq.com' }),
    },
  },
}));

import { GET, POST } from '../route';
import { POST as approve } from '../[id]/approve/route';
import { POST as reject } from '../[id]/reject/route';
import { POST as cancel } from '../[id]/cancel/route';
import { POST as pingBillRoute } from '../[id]/ping-bill/route';

const VALID_PERIOD = '11111111-1111-1111-1111-111111111111';
const VALID_EMPLOYEE = '22222222-2222-2222-2222-222222222222';

function req(body?: unknown): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request('http://x/api/bonus/amendments', init);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const validBody = {
  bonusPayPeriodId: VALID_PERIOD,
  targetEntryDate: '2026-06-10',
  bonusEmployeeId: VALID_EMPLOYEE,
  changeType: 'update' as const,
  newValue: { mattress_count: 67, note: null },
  justification: 'Keyed 76 by mistake, the real count is 67 mattresses.',
};

beforeEach(() => {
  accessCtx = { siteId: 'site-woodland', userId: 'janette', isAdmin: false, siteName: 'Woodland' };
  vi.clearAllMocks();
  buildNotifyContext.mockResolvedValue({ requestId: 'amd-1' } as never);
});

describe('POST /api/bonus/amendments', () => {
  it('admin → 400 admin_uses_direct_path', async () => {
    accessCtx.isAdmin = true;
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'admin_uses_direct_path' });
    expect(submitAmendmentRequest).not.toHaveBeenCalled();
  });

  it('Patrick (forbidden) → 403 patrick_or_other_non_chain_manager', async () => {
    submitAmendmentRequest.mockRejectedValueOnce(
      new AmendmentWorkflowForbiddenError('patrick_or_other_non_chain_manager'),
    );
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'patrick_or_other_non_chain_manager' });
  });

  it('happy path → 201 with request body + fires the submitted notification', async () => {
    submitAmendmentRequest.mockResolvedValueOnce({
      id: 'amd-1',
      expected_approver_user_id: 'morena',
    });
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ request: { id: 'amd-1' } });
    expect(notifyAmendmentSubmitted).toHaveBeenCalledTimes(1);
  });

  it('invalid body (missing justification) → 422', async () => {
    const { justification: _omit, ...bad } = validBody;
    void _omit;
    const res = await POST(req(bad) as never);
    expect(res.status).toBe(422);
    expect(submitAmendmentRequest).not.toHaveBeenCalled();
  });

  it('maps a service AmendmentRequestError to its status', async () => {
    submitAmendmentRequest.mockRejectedValueOnce(
      new AmendmentRequestError('period_not_draft', 409),
    );
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'period_not_draft' });
  });
});

describe('GET /api/bonus/amendments', () => {
  it('as a manager → calls listPendingForApprover scoped to their site', async () => {
    listPendingForApprover.mockResolvedValueOnce([{ id: 'amd-1' }]);
    const res = await GET(req() as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requests: [{ id: 'amd-1' }] });
    expect(listPendingForApprover).toHaveBeenCalledWith('janette', false, 'site-woodland');
  });

  it('as an admin → calls listPendingForApprover with null site (all sites)', async () => {
    accessCtx = { ...accessCtx, userId: 'bill', isAdmin: true };
    listPendingForApprover.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    await GET(req() as never);
    expect(listPendingForApprover).toHaveBeenCalledWith('bill', true, null);
  });
});

describe('POST /api/bonus/amendments/[id]/approve', () => {
  it('happy path → 200, fires the approved notification', async () => {
    accessCtx = { ...accessCtx, userId: 'morena' };
    approveAmendmentRequest.mockResolvedValueOnce({
      request: { id: 'amd-1', state: 'approved', requested_by_user_id: 'janette' },
    });
    const res = await approve(req({}) as never, params('amd-1') as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request: { state: 'approved' } });
    expect(notifyAmendmentApproved).toHaveBeenCalledTimes(1);
  });

  it('by the requester → 403 (service rejects not_eligible_to_approve)', async () => {
    approveAmendmentRequest.mockRejectedValueOnce(
      new AmendmentRequestError('not_eligible_to_approve', 403),
    );
    const res = await approve(req({}) as never, params('amd-1') as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'not_eligible_to_approve' });
    expect(notifyAmendmentApproved).not.toHaveBeenCalled();
  });
});

describe('POST /api/bonus/amendments/[id]/reject', () => {
  it('without decisionNotes → 422 (route-level zod)', async () => {
    const res = await reject(req({}) as never, params('amd-1') as never);
    expect(res.status).toBe(422);
    expect(rejectAmendmentRequest).not.toHaveBeenCalled();
  });

  it('happy path → 200, fires the rejected notification', async () => {
    accessCtx = { ...accessCtx, userId: 'morena' };
    rejectAmendmentRequest.mockResolvedValueOnce({
      id: 'amd-1',
      state: 'rejected',
      requested_by_user_id: 'janette',
    });
    const res = await reject(
      req({ decisionNotes: 'Count is correct as keyed.' }) as never,
      params('amd-1') as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request: { state: 'rejected' } });
    expect(notifyAmendmentRejected).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/bonus/amendments/[id]/cancel', () => {
  it('by a non-requester → 403', async () => {
    cancelAmendmentRequest.mockRejectedValueOnce(
      new AmendmentRequestError('cancel_only_by_requester', 403),
    );
    const res = await cancel(req() as never, params('amd-1') as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'cancel_only_by_requester' });
  });

  it('by the requester → 200, state cancelled', async () => {
    cancelAmendmentRequest.mockResolvedValueOnce({ id: 'amd-1', state: 'cancelled' });
    const res = await cancel(req() as never, params('amd-1') as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request: { state: 'cancelled' } });
  });
});

describe('POST /api/bonus/amendments/[id]/ping-bill', () => {
  it('first ping → 200, fires the ping-bill notification', async () => {
    pingBill.mockResolvedValueOnce({ request: { id: 'amd-1' }, firstPing: true });
    const res = await pingBillRoute(req() as never, params('amd-1') as never);
    expect(res.status).toBe(200);
    expect(notifyAmendmentBillPinged).toHaveBeenCalledTimes(1);
  });

  it('second ping → 200, NO second notification (firstPing false)', async () => {
    pingBill.mockResolvedValueOnce({ request: { id: 'amd-1' }, firstPing: false });
    const res = await pingBillRoute(req() as never, params('amd-1') as never);
    expect(res.status).toBe(200);
    expect(notifyAmendmentBillPinged).not.toHaveBeenCalled();
  });
});
