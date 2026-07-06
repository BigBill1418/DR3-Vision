// ADR-0046 D4 — approvals: first-action-wins (both attempts audited), decision
// email to FIXED recipients, refuse-when-empty, pending count, approver set.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeApRequest, type FakeDb, type FakeUser } from './__testutils__/fake-prisma';
import {
  ApAlreadyDecidedError,
  apApproverEmails,
  decideRequest,
  pendingApCount,
} from './approvals';

const writeAudit = vi.fn();
const sendSystemEmail = vi.fn(async () => ({ delivered: true, disabled: false, messageId: 'm', retries: 0, lastStatus: 202 }));
const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: () => sendSystemEmail() }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: () => publishNtfy() }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function pendingReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending',
    internet_message_id: '<x@svdp.us>',
    conversation_id: null,
    received_at: new Date(),
    sender_address: 'morena@svdp.us',
    sender_validated: true,
    subject: 'Invoice #4471',
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    quarantine_reason: null,
    ...over,
  };
}
const users: FakeUser[] = [
  { id: 'u-morena', name: 'Morena', email: 'morena@svdp.us', role: 'manager', all_sites: true, is_active: true },
  { id: 'u-janette', name: 'Janette', email: 'janette@svdp.us', role: 'manager', all_sites: true, is_active: true },
  { id: 'u-op', name: 'Op', email: null, role: 'operator', all_sites: false, is_active: true },
];

beforeEach(() => {
  writeAudit.mockClear();
  sendSystemEmail.mockClear();
  publishNtfy.mockClear();
});

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

describe('decideRequest — first action wins + both attempts audited', () => {
  it('approves a pending request, emails the fixed recipients, stamps decision_mail_sent_at', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest({ prisma: fp(db), requestId: 'req-1', decision: 'approved', actorUserId: 'u-morena' });
    expect(res.decision).toBe('approved');
    expect(res.mail).toBe('sent');
    expect(db.requests[0]!.status).toBe('approved');
    expect(db.requests[0]!.decided_by).toBe('u-morena');
    expect(db.requests[0]!.decision_mail_sent_at).not.toBeNull();
    expect(sendSystemEmail).toHaveBeenCalledTimes(1); // one recipient
    // winner audited (won)
    expect(writeAudit).toHaveBeenCalled();
  });

  it('the loser of a race gets ApAlreadyDecidedError; BOTH attempts are audited', async () => {
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: [{ email: 'mary@svdp.us', active: true }] });
    const prisma = fp(db);
    await decideRequest({ prisma, requestId: 'req-1', decision: 'approved', actorUserId: 'u-morena' });
    writeAudit.mockClear();
    await expect(
      decideRequest({ prisma, requestId: 'req-1', decision: 'rejected', actorUserId: 'u-janette' }),
    ).rejects.toBeInstanceOf(ApAlreadyDecidedError);
    // the losing attempt is audited (outcome=lost)
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const arg = writeAudit.mock.calls[0]![0] as unknown as { after?: { outcome?: string } };
    expect(arg.after?.outcome).toBe('lost');
    // state unchanged from the winner
    expect(db.requests[0]!.status).toBe('approved');
  });

  it('carries the vendor/amount/note when supplied at decision (C9-D5 optional fields)', async () => {
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: [{ email: 'mary@svdp.us', active: true }] });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      vendor: 'Acme',
      amountCents: 44100,
      note: 'ok to pay',
    });
    expect(db.requests[0]!.vendor).toBe('Acme');
    expect(db.requests[0]!.amount_cents).toBe(44100);
    expect(db.requests[0]!.decision_note).toBe('ok to pay');
  });
});

describe('decision email — fixed recipients, refuse when empty', () => {
  it('REFUSES to send + pages when the recipient list is empty (decision still stands)', async () => {
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: [] });
    const res = await decideRequest({ prisma: fp(db), requestId: 'req-1', decision: 'approved', actorUserId: 'u-morena' });
    expect(res.mail).toBe('refused_no_recipients');
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(publishNtfy).toHaveBeenCalledTimes(1); // loud refusal
    expect(db.requests[0]!.status).toBe('approved'); // the decision itself stands
  });
});

describe('approver set + pending count (data)', () => {
  it('apApproverEmails = active admin/all_sites users with an email', async () => {
    const db = newFakeDb({ users });
    expect((await apApproverEmails(fp(db))).sort()).toEqual(['janette@svdp.us', 'morena@svdp.us']);
  });
  it('pendingApCount counts only pending', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ id: 'a' }), pendingReq({ id: 'b', internet_message_id: '<b>', status: 'approved' })],
    });
    expect(await pendingApCount(fp(db))).toBe(1);
  });
});
