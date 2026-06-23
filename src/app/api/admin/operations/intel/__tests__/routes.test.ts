// ADR-0034 — admin route guard + send-gate tests (§14.5).
//
// Mirrors the production-report routes test idiom: mock @/lib/auth, fully mock
// the service layer + prisma, and drive the real route handlers directly.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

// Routes read ip/user-agent from next/headers; provide a request-free stub.
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'vitest' }),
}));

const createCampaign = vi.fn();
const listCampaigns = vi.fn();
const approveInvite = vi.fn();
const markInviteSent = vi.fn();
vi.mock('@/lib/survey/campaigns', () => {
  class SurveyCampaignError extends Error {
    readonly status: number;
    constructor(
      public readonly reason: string,
      statusCode = 422,
    ) {
      super(`survey-campaign: ${reason}`);
      this.name = 'SurveyCampaignError';
      this.status = statusCode;
    }
  }
  return {
    SurveyCampaignError,
    createCampaign: (...a: unknown[]) => createCampaign(...a),
    listCampaigns: (...a: unknown[]) => listCampaigns(...a),
    approveInvite: (...a: unknown[]) => approveInvite(...a),
    markInviteSent: (...a: unknown[]) => markInviteSent(...a),
  };
});

// Prisma double for the send route (reads approved invites directly).
const campaignFindUnique = vi.fn();
const campaignUpdate = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    surveyCampaign: {
      findUnique: (...a: unknown[]) => campaignFindUnique(...a),
      update: (...a: unknown[]) => campaignUpdate(...a),
    },
  },
}));

const sendInvite = vi.fn();
vi.mock('@/lib/survey/notifications', () => ({
  sendInvite: (...a: unknown[]) => sendInvite(...a),
}));

import { auth } from '@/lib/auth';
import { SurveyCampaignError } from '@/lib/survey/campaigns';
import { POST as postCampaign } from '../campaigns/route';
import { POST as postSend } from '../campaigns/[id]/send/route';
import { POST as postApprove } from '../campaigns/[id]/invites/[inviteId]/approve/route';

const BILL = { id: 'user-bill', email: 'bill.barnard@svdp.us', is_super_admin: true };
const KELSEY = { id: 'user-kelsey', email: 'kelsey@svdp.us', is_super_admin: false };

function asUser(user: typeof BILL | typeof KELSEY | null) {
  (auth as unknown as Mock).mockResolvedValue(user ? { user } : null);
}

function jsonReq(body: unknown, url = 'http://127.0.0.1:3000/api/admin/operations/intel'): NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  createCampaign.mockResolvedValue({ id: 'camp-new' });
});

describe('POST /api/admin/operations/intel/campaigns', () => {
  it('30. returns 403 when caller is not super-admin', async () => {
    asUser(KELSEY);
    const res = await postCampaign(jsonReq({ title: 'T', slug: 't', intro_text: 'x' }));
    expect(res.status).toBe(403);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it('403 when unauthenticated', async () => {
    asUser(null);
    const res = await postCampaign(jsonReq({ title: 'T', slug: 't', intro_text: 'x' }));
    expect(res.status).toBe(403);
  });

  it('201 when Bill (super-admin) creates a valid campaign', async () => {
    asUser(BILL);
    const res = await postCampaign(jsonReq({ title: 'T', slug: 't', intro_text: 'x' }));
    expect(res.status).toBe(201);
    expect(createCampaign).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/admin/operations/intel/campaigns/:id/send', () => {
  const ctx = { params: Promise.resolve({ id: 'camp-1' }) };

  it('31. returns 422 count_diverged when confirmed_recipient_count does not match approved-count', async () => {
    asUser(BILL);
    campaignFindUnique.mockResolvedValue({
      id: 'camp-1',
      status: 'open',
      invites: [{ id: 'a' }, { id: 'b' }],
    });
    const res = await postSend(jsonReq({ confirmed_recipient_count: 3 }), ctx);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('count_diverged');
    expect(body.expected).toBe(2);
    expect(body.provided).toBe(3);
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('32. returns 422 no_approved_invites when nothing is approved', async () => {
    asUser(BILL);
    campaignFindUnique.mockResolvedValue({ id: 'camp-1', status: 'open', invites: [] });
    const res = await postSend(jsonReq({ confirmed_recipient_count: 0 }), ctx);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('no_approved_invites');
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('403 on the send route when caller is not super-admin', async () => {
    asUser(KELSEY);
    const res = await postSend(jsonReq({ confirmed_recipient_count: 0 }), ctx);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/operations/intel/campaigns/:id/invites/:inviteId/approve', () => {
  const ctx = { params: Promise.resolve({ id: 'camp-1', inviteId: 'inv-1' }) };

  it('33. returns 409 when invite is not in draft', async () => {
    asUser(BILL);
    approveInvite.mockRejectedValueOnce(new SurveyCampaignError('invalid_status', 409));
    const req = jsonReq(
      {},
      'http://127.0.0.1:3000/api/admin/operations/intel/campaigns/camp-1/invites/inv-1/approve',
    );
    const res = await postApprove(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('invalid_status');
  });

  it('200 when approve succeeds', async () => {
    asUser(BILL);
    approveInvite.mockResolvedValueOnce({ id: 'inv-1', status: 'approved' });
    const req = jsonReq(
      {},
      'http://127.0.0.1:3000/api/admin/operations/intel/campaigns/camp-1/invites/inv-1/approve',
    );
    const res = await postApprove(req, ctx);
    expect(res.status).toBe(200);
  });
});
