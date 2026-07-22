// ADR-0046 Amendment 5 (D-M5-3) — the $1,000 second-approval workflow:
// state-machine transitions, site-tag routing, the first==second self-fulfillment
// edge case (re-confirm + 30s wait), override-rejection routing (both approvers +
// CC the first approver), and first-action-wins among second approvers.

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
} from './__testutils__/fake-prisma';
import { decideRequest, ApAlreadyDecidedError } from './approvals';
import {
  decideSecondApproval,
  requiresSecondApproval,
  canFulfillSecondApproval,
  activeSecondApproversForSite,
  awaitingSecondApprovalCount,
  ApSecondApprovalNotEligibleError,
  ApSecondApprovalReconfirmRequiredError,
  ApSecondApprovalTooSoonError,
  SECOND_APPROVAL_THRESHOLD_CENTS,
} from './second-approval';
import { stampText } from './stamp';

const writeAudit = vi.fn();
const sendSystemEmail = vi.fn(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'm',
  retries: 0,
  lastStatus: 202,
}));
const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));
const notifyStaffSpy = vi.fn();

const stamp = vi.hoisted(() => ({
  stampApproval: vi.fn(async () => ({ pdf: Buffer.from('%PDF-stub'), sha256: 'deadbeef' })),
  stampOntoOriginalPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-overlay'), sha256: 'pdfsha' })),
  stampImage: vi.fn(async () => ({ pdf: Buffer.from('%PDF-image'), sha256: 'imgsha' })),
}));
const r2 = vi.hoisted(() => ({
  getApAttachmentBytes: vi.fn(async (): Promise<Uint8Array | null> => null),
  putApDecisionPdf: vi.fn(async (): Promise<string | null> => 'ap/x/decision/y.pdf'),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: () => sendSystemEmail() }));
// NOTE: ./stamp is only partially mocked — the render functions are stubbed, but the
// pure `stampText` is the REAL export (a dual-approval unit test asserts it below).
vi.mock('./stamp', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...stamp };
});
vi.mock('@/lib/r2', () => r2);
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: ReadonlyArray<string | { address: string }> }) => {
    notifyStaffSpy(args);
    const recips = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
    const sends: Array<{ delivered: boolean; disabled: boolean }> = [];
    for (let i = 0; i < recips.length; i++) {
      sends.push((await sendSystemEmail()) as { delivered: boolean; disabled: boolean });
    }
    const disabled = sends.length > 0 && sends.every((s) => s.disabled);
    const delivered = sends.filter((s) => s.delivered).length;
    return { mode: 'live' as const, disabled, delivered, actualRecipients: recips };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({ NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify' } }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sites: FakeSite[] = [
  { id: 'site-w', code: 'woodland', name: 'Woodland' },
  { id: 'site-e', code: 'eugene', name: 'Eugene' },
];
const users: FakeUser[] = [
  { id: 'u-morena', name: 'Morena', email: 'morena@svdp.us', role: 'manager', all_sites: true, is_active: true },
  { id: 'u-bill', name: 'Bill', email: 'bill@svdp.us', role: 'admin', all_sites: true, is_active: true },
  { id: 'u-shannon', name: 'Shannon Rockwell', email: 'shannon@svdp.us', role: 'manager', all_sites: false, is_active: true },
  { id: 'u-janette', name: 'Janette', email: 'janette@svdp.us', role: 'manager', all_sites: false, is_active: true },
];
const secondApprovers: FakeSecondApprover[] = [
  { id: 'sa-shannon', user_id: 'u-shannon', site_id: 'eugene', active: true, active_until: null },
];

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

/** A pending request ready for a first structured Approve. */
function pendingReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending',
    internet_message_id: '<x@svdp.us>',
    conversation_id: null,
    received_at: new Date(),
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
    quarantine_reason: null,
    site_id: null,
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    ...over,
  };
}

/** A request already first-approved and AWAITING second approval. */
function awaitingReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return pendingReq({
    status: 'pending_second_approval',
    site_id: 'site-e',
    vendor_freeform: 'ACME Repairs',
    explanation: 'Baler hydraulics rebuild',
    confirmed_amount_cents: 250000,
    first_approver_id: 'u-morena',
    first_approved_at: new Date('2026-07-22T10:00:00Z'),
    ...over,
  });
}

function structuredApproveArgs(db: FakeDb, over: Record<string, unknown> = {}) {
  return {
    prisma: fp(db),
    requestId: 'req-1',
    decision: 'approved' as const,
    actorUserId: 'u-morena',
    siteId: 'site-e',
    vendorFreeform: 'ACME Repairs',
    explanation: 'Baler hydraulics rebuild',
    confirmedAmountCents: 250000,
    equipmentLinks: { equipmentIds: [] as string[], notEquipmentRelated: true },
    varianceFlagState: 'not_applicable' as const,
    ...over,
  };
}

beforeEach(() => {
  writeAudit.mockClear();
  sendSystemEmail.mockClear();
  publishNtfy.mockClear();
  notifyStaffSpy.mockClear();
  stamp.stampApproval.mockClear();
  r2.getApAttachmentBytes.mockReset();
  r2.getApAttachmentBytes.mockResolvedValue(null);
  r2.putApDecisionPdf.mockReset();
  r2.putApDecisionPdf.mockResolvedValue('ap/x/decision/y.pdf');
});

describe('threshold', () => {
  it('>= $1,000 triggers a second approval; below does not', () => {
    expect(SECOND_APPROVAL_THRESHOLD_CENTS).toBe(100_000);
    expect(requiresSecondApproval(100_000)).toBe(true);
    expect(requiresSecondApproval(99_999)).toBe(false);
    expect(requiresSecondApproval(null)).toBe(false);
  });
});

describe('first leg — decideRequest routes a >= $1,000 Approve to pending_second_approval', () => {
  it('moves to pending_second_approval, stamps the first approver, sends NO decision email, pages the second approver', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      sites,
      secondApprovers,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest(structuredApproveArgs(db));
    expect(res.decision).toBe('approved');
    expect(res.secondApprovalPending).toBe(true);
    expect(res.mail).toBe('second_approval_pending');
    expect(res.secondApproverLabel).toBe('Eugene (Shannon Rockwell)');
    const row = db.requests[0]!;
    expect(row.status).toBe('pending_second_approval');
    expect(row.first_approver_id).toBe('u-morena');
    expect(row.first_approved_at).not.toBeNull();
    expect(row.decided_by).toBeNull(); // terminal decision NOT taken yet
    expect(row.decided_at).toBeNull();
    // No DECISION email (decision_mail_sent_at stays null); the routing page + a
    // routing email to the second approver fired instead.
    expect(row.decision_mail_sent_at).toBeFalsy();
    const subjects = notifyStaffSpy.mock.calls.map((c) => (c[0] as { subject: string }).subject);
    expect(subjects.every((s) => !/AP decision/.test(s))).toBe(true);
    expect(subjects.some((s) => /second approval needed/i.test(s))).toBe(true);
    expect(publishNtfy).toHaveBeenCalled();
  });

  it('sub-$1,000 Approve terminates at approved (unchanged single-action contract) and emails', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      sites,
      secondApprovers,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest(structuredApproveArgs(db, { confirmedAmountCents: 99_999 }));
    expect(res.secondApprovalPending).toBeUndefined();
    expect(res.mail).toBe('sent');
    expect(db.requests[0]!.status).toBe('approved');
    expect(db.requests[0]!.decided_by).toBe('u-morena');
    expect(db.requests[0]!.first_approver_id).toBeFalsy();
  });

  it('a >= $1,000 REJECT is NOT dual — rejects in one action (threshold applies to Approve only)', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      sites,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actorUserId: 'u-morena',
      siteId: 'site-e',
      note: 'Wrong vendor',
    });
    expect(res.decision).toBe('rejected');
    expect(db.requests[0]!.status).toBe('rejected');
  });
});

describe('routing + eligibility', () => {
  it('Eugene routes to the rostered Shannon; Woodland has no roster row (relies on admin-eligibility)', async () => {
    const db = newFakeDb({ users, sites, secondApprovers });
    const eugene = await activeSecondApproversForSite(fp(db), 'eugene');
    expect(eugene.userIds).toEqual(['u-shannon']);
    expect(eugene.emails).toEqual(['shannon@svdp.us']);
    const woodland = await activeSecondApproversForSite(fp(db), 'woodland');
    expect(woodland.userIds).toEqual([]);
  });

  it('admin is always eligible; rostered Shannon eligible for Eugene; a regular approver is NOT', async () => {
    const db = newFakeDb({ users, sites, secondApprovers });
    const p = fp(db);
    expect(await canFulfillSecondApproval(p, { userId: 'u-bill', role: 'admin' }, 'eugene')).toBe(true);
    expect(await canFulfillSecondApproval(p, { userId: 'u-bill', role: 'admin' }, 'woodland')).toBe(true);
    expect(await canFulfillSecondApproval(p, { userId: 'u-shannon', role: 'manager' }, 'eugene')).toBe(true);
    // Shannon is rostered for Eugene, not Woodland.
    expect(await canFulfillSecondApproval(p, { userId: 'u-shannon', role: 'manager' }, 'woodland')).toBe(false);
    // Morena is a first approver but not a second approver anywhere.
    expect(await canFulfillSecondApproval(p, { userId: 'u-morena', role: 'manager' }, 'eugene')).toBe(false);
  });
});

describe('second leg — decideSecondApproval', () => {
  it('rostered second approver (Shannon) confirms → approved + decision email with BOTH approvers', async () => {
    const db = newFakeDb({
      requests: [awaitingReq()],
      users,
      sites,
      secondApprovers,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideSecondApproval({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actor: { userId: 'u-shannon', role: 'manager' },
    });
    expect(res.decision).toBe('approved');
    expect(res.mail).toBe('sent');
    const row = db.requests[0]!;
    expect(row.status).toBe('approved');
    expect(row.second_approver_id).toBe('u-shannon');
    expect(row.second_approved_at).not.toBeNull();
    expect(row.decided_by).toBe('u-shannon');
    // Email body names BOTH approvers.
    const body = notifyStaffSpy.mock.calls[0]![0] as { htmlBody: string };
    expect(body.htmlBody).toContain('Morena');
    expect(body.htmlBody).toContain('Shannon Rockwell');
  });

  it('admin (Bill) may fulfill a Eugene second approval (always eligible)', async () => {
    const db = newFakeDb({
      requests: [awaitingReq()],
      users,
      sites,
      secondApprovers,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideSecondApproval({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actor: { userId: 'u-bill', role: 'admin' },
    });
    expect(res.decision).toBe('approved');
    expect(db.requests[0]!.status).toBe('approved');
  });

  it('a non-eligible actor is REFUSED (403) and the request stays awaiting', async () => {
    const db = newFakeDb({ requests: [awaitingReq()], users, sites, secondApprovers });
    await expect(
      decideSecondApproval({
        prisma: fp(db),
        requestId: 'req-1',
        decision: 'approved',
        actor: { userId: 'u-janette', role: 'manager' },
      }),
    ).rejects.toBeInstanceOf(ApSecondApprovalNotEligibleError);
    expect(db.requests[0]!.status).toBe('pending_second_approval');
  });

  it('second-approver REJECT → rejected, stamps second_approver_note, CCs the first approver', async () => {
    const db = newFakeDb({
      requests: [awaitingReq()],
      users,
      sites,
      secondApprovers,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideSecondApproval({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actor: { userId: 'u-shannon', role: 'manager' },
      note: 'Amount exceeds the approved scope',
    });
    expect(res.decision).toBe('rejected');
    const row = db.requests[0]!;
    expect(row.status).toBe('rejected');
    expect(row.second_approver_note).toBe('Amount exceeds the approved scope');
    // The first approver (morena) is CC'd on the override rejection.
    const args = notifyStaffSpy.mock.calls[0]![0] as { cc?: string[]; htmlBody: string };
    expect(args.cc).toContain('morena@svdp.us');
    expect(args.htmlBody).toContain('Amount exceeds the approved scope');
  });

  it('a second-approval reject with NO note is refused (override must be explained)', async () => {
    const db = newFakeDb({ requests: [awaitingReq()], users, sites, secondApprovers });
    await expect(
      decideSecondApproval({
        prisma: fp(db),
        requestId: 'req-1',
        decision: 'rejected',
        actor: { userId: 'u-shannon', role: 'manager' },
      }),
    ).rejects.toThrow(/overridden/i);
  });

  it('fulfilling an already-decided request loses the race (ApAlreadyDecidedError)', async () => {
    const db = newFakeDb({
      requests: [awaitingReq({ status: 'approved', decided_by: 'u-shannon', decided_at: new Date() })],
      users,
      sites,
      secondApprovers,
    });
    await expect(
      decideSecondApproval({
        prisma: fp(db),
        requestId: 'req-1',
        decision: 'approved',
        actor: { userId: 'u-bill', role: 'admin' },
      }),
    ).rejects.toBeInstanceOf(ApAlreadyDecidedError);
  });
});

describe('first == second self-fulfillment edge case (decision (c))', () => {
  // Bill is BOTH the first approver AND (as admin) an eligible second approver.
  function billFirstApproved(over: Partial<FakeApRequest> = {}): FakeApRequest {
    return awaitingReq({
      site_id: 'site-w', // Woodland → Bill
      first_approver_id: 'u-bill',
      first_approved_at: new Date(Date.now() - 60_000), // 60s ago (past the 30s wait)
      ...over,
    });
  }

  it('self-fulfillment WITHOUT the re-confirm flag is refused', async () => {
    const db = newFakeDb({ requests: [billFirstApproved()], users, sites, secondApprovers });
    await expect(
      decideSecondApproval({
        prisma: fp(db),
        requestId: 'req-1',
        decision: 'approved',
        actor: { userId: 'u-bill', role: 'admin' },
      }),
    ).rejects.toBeInstanceOf(ApSecondApprovalReconfirmRequiredError);
    expect(db.requests[0]!.status).toBe('pending_second_approval');
  });

  it('self-fulfillment BEFORE the 30-second minimum wait is refused (even with re-confirm)', async () => {
    const db = newFakeDb({
      requests: [billFirstApproved({ first_approved_at: new Date(Date.now() - 5_000) })], // 5s ago
      users,
      sites,
      secondApprovers,
    });
    await expect(
      decideSecondApproval({
        prisma: fp(db),
        requestId: 'req-1',
        decision: 'approved',
        actor: { userId: 'u-bill', role: 'admin' },
        reconfirm: true,
      }),
    ).rejects.toBeInstanceOf(ApSecondApprovalTooSoonError);
  });

  it('self-fulfillment WITH re-confirm AFTER 30s succeeds → approved', async () => {
    const db = newFakeDb({
      requests: [billFirstApproved()],
      users,
      sites,
      secondApprovers,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideSecondApproval({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actor: { userId: 'u-bill', role: 'admin' },
      reconfirm: true,
    });
    expect(res.decision).toBe('approved');
    const row = db.requests[0]!;
    expect(row.status).toBe('approved');
    expect(row.first_approver_id).toBe('u-bill');
    expect(row.second_approver_id).toBe('u-bill');
  });
});

describe('awaiting-2nd badge count', () => {
  it('admin sees all awaiting; rostered second approver sees only their site; others see 0', async () => {
    const db = newFakeDb({
      requests: [awaitingReq({ id: 'r-e', site_id: 'site-e' }), awaitingReq({ id: 'r-w', site_id: 'site-w' })],
      users,
      sites,
      secondApprovers,
    });
    const p = fp(db);
    expect(await awaitingSecondApprovalCount(p, { userId: 'u-bill', role: 'admin' })).toBe(2);
    expect(await awaitingSecondApprovalCount(p, { userId: 'u-shannon', role: 'manager' })).toBe(1); // Eugene only
    expect(await awaitingSecondApprovalCount(p, { userId: 'u-morena', role: 'manager' })).toBe(0);
  });
});

describe('stamp — dual-approval visible line', () => {
  it('a >= $1,000 approved stamp names BOTH approvers + PT timestamps', () => {
    const line = stampText({
      decision: 'approved',
      approverName: 'Morena',
      decidedAt: new Date('2026-07-22T17:00:00Z'),
      siteName: 'Eugene',
      secondApproverName: 'Shannon Rockwell',
      secondApprovedAt: new Date('2026-07-22T18:00:00Z'),
    });
    expect(line).toMatch(/^Approved by Morena on .+ PT via DR3-Vision; second approval by Shannon Rockwell on .+ PT — Site: Eugene$/);
  });

  it('a single-approver stamp carries no second-approval clause', () => {
    const line = stampText({ decision: 'approved', approverName: 'Morena', decidedAt: new Date() });
    expect(line).not.toContain('second approval');
  });
});
