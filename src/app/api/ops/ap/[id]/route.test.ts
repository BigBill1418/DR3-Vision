// ADR-0066 incident (2026-09-18) — the AP detail panel's `eligible` flag.
//
// The Approve/Reject panel for a >= $1,000 second approval renders ONLY when this
// route returns `secondApproval.eligible === true` (ApQueueClient: `{sa?.eligible ?`).
// Until this fix it answered that question with the SUPERSEDED per-site
// `ap_second_approvers` check, while the decide route authorized the write through
// `canFulfillSecondApprovalByRouting`. The two disagreed: the legacy table holds a
// single row (Shannon/eugene), so every routed peer was shown NO BUTTON for a write
// the server would have accepted. Bill fulfilled 38 of 38 second approvals between
// 2026-07-28 (ADR-0066) and 2026-09-18.
//
// These tests pin the flag to the ROUTING resolver in the real production shape:
// the Woodland pair (Morena <-> Janette) hold no legacy roster row at all.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
  type FakeSecondApprover,
  type FakeSite,
  type FakeUser,
} from '@/lib/ap/__testutils__/fake-prisma';

const state = vi.hoisted(() => ({
  prisma: null as unknown as PrismaClient,
  identity: { userId: 'u-janette', viewer: { role: 'manager' } } as {
    userId: string;
    viewer: { role: string };
  },
  detail: { id: 'r-w', status: 'pending_second_approval' } as Record<string, unknown>,
}));

// A stable object whose property reads forward to whatever fake db the test built.
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({} as Record<string, unknown>, {
    get: (_t, p) => (state.prisma as unknown as Record<string, unknown>)[p as string],
  }),
}));
vi.mock('@/lib/ap/approvers', () => ({ requireApApprover: vi.fn(async () => state.identity) }));
vi.mock('@/lib/ap/queue', () => ({ getApRequestDetail: vi.fn(async () => state.detail) }));
// Kept shallow: the real module drags stamp/r2/mail into the graph for one constant.
// The SUPERSEDED `canFulfillSecondApproval` is re-exported from its real leaf module
// on purpose — so that reverting the fix makes these tests fail with a genuine
// `expected false to be true`, not with "the mock has no such export". The
// counterfactual has to exercise the legacy code path to be worth anything.
vi.mock('@/lib/ap/second-approval', async () => {
  const routing = await import('@/lib/ap/second-approval-routing');
  return {
    SECOND_APPROVAL_SELF_MIN_WAIT_MS: 30_000,
    canFulfillSecondApproval: routing.canFulfillSecondApproval,
  };
});

import { GET } from './route';

const sites: FakeSite[] = [
  { id: 'site-w', code: 'woodland', name: 'Woodland' },
  { id: 'site-e', code: 'eugene', name: 'Eugene' },
];

// Production roles/sites: every manager is SINGLE-site (all_sites false), which is
// why the site term in the resolver has to be exercised rather than short-circuited.
const users: FakeUser[] = [
  {
    id: 'u-morena',
    name: 'Morena Gomez',
    email: 'morena.gomez@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 'site-w',
  },
  {
    id: 'u-janette',
    name: 'Janette Tomas',
    email: 'janette.tomas@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 'site-w',
  },
  {
    id: 'u-rick',
    name: 'Rick Albritton',
    email: 'rick.albritton@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 'site-e',
  },
  {
    id: 'u-shannon',
    name: 'Shannon Rockwell',
    email: 'shannon.rockwell@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 'site-e',
  },
  {
    id: 'u-bill',
    name: 'Bill Barnard',
    email: 'bill.barnard@svdp.us',
    role: 'admin',
    all_sites: false,
    is_active: true,
  },
];

// PRODUCTION TRUTH: the legacy roster contains Shannon/eugene and nobody else.
// This is the fixture that makes the bug reproducible — the Woodland pair are
// absent from it, so the superseded check answered FALSE for both of them.
const secondApprovers: FakeSecondApprover[] = [
  { id: 'sa-shannon', user_id: 'u-shannon', site_id: 'eugene', active: true, active_until: null },
];

const approvalRouting = [
  {
    id: 'ar-mg',
    first_approver_id: 'u-morena',
    second_approver_id: 'u-janette',
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'ar-jt',
    first_approver_id: 'u-janette',
    second_approver_id: 'u-morena',
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'ar-ra',
    first_approver_id: 'u-rick',
    second_approver_id: 'u-shannon',
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
  {
    id: 'ar-sr',
    first_approver_id: 'u-shannon',
    second_approver_id: 'u-rick',
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
];

/** A >= $1,000 request first-approved by Morena, filed against WOODLAND. */
function awaitingReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'r-w',
    status: 'pending_second_approval',
    internet_message_id: '<inv@svdp.us>',
    conversation_id: null,
    received_at: new Date('2026-09-17T10:00:00Z'),
    sender_address: 'forwarder@svdp.us',
    sender_validated: true,
    subject: 'Invoice #9001',
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    decision_mail_filed_out_of_band_at: null,
    quarantine_reason: null,
    site_id: 'site-w',
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    vendor_freeform: 'Allied Propane Service',
    explanation: 'propane delivery',
    confirmed_amount_cents: 1_802_044,
    first_approver_id: 'u-morena',
    first_approved_at: new Date('2026-09-17T22:02:19Z'),
    ...over,
  } as FakeApRequest;
}

function seed(over: Partial<FakeDb> = {}): void {
  const db = newFakeDb({
    requests: [awaitingReq()],
    users,
    sites,
    secondApprovers,
    approvalRouting,
    ...over,
  });
  state.prisma = makeFakePrisma(db) as unknown as PrismaClient;
}

async function eligibilityFor(
  userId: string,
  role: string,
): Promise<{ eligible: boolean; isFirstApprover: boolean } | null> {
  state.identity = { userId, viewer: { role } };
  const res = await GET(new Request('http://127.0.0.1:3000/x'), {
    params: Promise.resolve({ id: 'r-w' }),
  });
  const body = (await res.json()) as {
    request: { secondApproval: { eligible: boolean; isFirstApprover: boolean } | null };
  };
  return body.request.secondApproval;
}

beforeEach(() => {
  state.detail = { id: 'r-w', status: 'pending_second_approval' };
  seed();
});

describe('AP detail — secondApproval.eligible (ADR-0066 regression)', () => {
  it('THE REGRESSION: the routed peer is eligible even with NO ap_second_approvers row', async () => {
    // Morena first-approved a Woodland invoice; routing sends the second signature
    // to Janette. Janette holds no legacy roster row — pre-fix this returned false
    // and the Approve/Reject panel never rendered for her.
    const sa = await eligibilityFor('u-janette', 'manager');
    expect(sa).not.toBeNull();
    expect(sa!.eligible).toBe(true);
    expect(sa!.isFirstApprover).toBe(false);
  });

  it('the flag agrees with the routing resolver, not the superseded site roster', async () => {
    // Shannon is the ONLY user in `ap_second_approvers` — but she is routed to Rick,
    // not to Morena, and she is Eugene while this invoice is Woodland. If the flag
    // ever tracks the legacy roster again, this flips to true and fails.
    const sa = await eligibilityFor('u-shannon', 'manager');
    expect(sa!.eligible).toBe(false);
  });

  it('hard rule #2 — a routed peer at the WRONG site is still refused', async () => {
    // Rick is routed as Shannon's peer, but a Woodland invoice is out of his reach.
    const sa = await eligibilityFor('u-rick', 'manager');
    expect(sa!.eligible).toBe(false);
  });

  it('admin remains eligible (unchanged rule — CLAUDE.md / handoff DO-NOT list)', async () => {
    const sa = await eligibilityFor('u-bill', 'admin');
    expect(sa!.eligible).toBe(true);
  });

  it('reports the first approver to the first approver (self-fulfilment panel state)', async () => {
    const sa = await eligibilityFor('u-morena', 'manager');
    expect(sa!.isFirstApprover).toBe(true);
  });

  it('a NOT-DR3 row is never fulfillable from this leg', async () => {
    seed({ requests: [awaitingReq({ filed_not_dr3: true })] });
    const sa = await eligibilityFor('u-janette', 'manager');
    expect(sa!.eligible).toBe(false);
  });

  it('a siteless row is never fulfillable from this leg', async () => {
    seed({ requests: [awaitingReq({ site_id: null })] });
    const sa = await eligibilityFor('u-janette', 'manager');
    expect(sa!.eligible).toBe(false);
  });

  it('no secondApproval block at all for a request not awaiting second approval', async () => {
    state.detail = { id: 'r-w', status: 'approved' };
    const sa = await eligibilityFor('u-janette', 'manager');
    expect(sa).toBeNull();
  });
});
