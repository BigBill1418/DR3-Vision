// ADVERSARIAL — scratch. Not part of the suite's contract.
//
// `escalated_at` is a ONE-SHOT LATCH: it is both the idempotency key and the only
// record that the escalation happened. It is written INSIDE the transaction; the
// email is sent OUTSIDE it, afterwards, fail-soft. Anything that stops the email
// after the claim commits burns the escalation permanently — the next hourly scan
// filters the row out on `escalated_at IS NULL` and never revisits it.
//
// Two reachable ways to get there, both proven below:
//   1. The escalation target has `second_approval_request` OFF. The claim stands,
//      the email set is empty, and NOTHING is reported: `problems` is empty and
//      `reportSecondApprovalRoutingProblem` is not called, because the §B.5 alarm
//      inspects `routed.recipients` (pre-pref-filter) rather than the send set.
//   2. The email send throws (transport blip, M365 429, container SIGTERM between
//      the commit and the send). The failure IS surfaced in `problems` for that
//      run — but the retry never happens, because the row is already latched.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
} from '../__testutils__/fake-prisma';

const publishNtfy = vi.fn(async (args?: unknown) => {
  void args;
  return { ok: true, outcome: 'sent' as const };
});
const notifySecondApprovalEscalated = vi.fn(async (args?: unknown) => {
  void args;
});
const reportSecondApprovalRoutingProblem = vi.fn(async (args?: unknown) => {
  void args;
});

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (args: unknown) => publishNtfy(args) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../notify', () => ({
  notifySecondApprovalEscalated: (args: unknown) => notifySecondApprovalEscalated(args),
  reportSecondApprovalRoutingProblem: (args: unknown) => reportSecondApprovalRoutingProblem(args),
}));

import { runApEscalationScan } from '../escalation-scan';

const fp = (db: FakeDb): PrismaClient => makeFakePrisma(db) as unknown as PrismaClient;

const FRI_4PM_PT = new Date('2026-07-24T23:00:00Z');
const MON_4PM_PT = new Date('2026-07-27T23:00:00Z'); // 24 business hours later
const TUE_4PM_PT = new Date('2026-07-28T23:00:00Z');

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
  bill: {
    id: 'u-bb',
    name: 'Bill Barnard',
    email: 'bill.barnard@svdp.us',
    role: 'admin' as const,
    all_sites: false,
    is_active: true,
  },
};

const SITES = [
  { id: 's-w', code: 'woodland', name: 'Woodland' },
  { id: 's-e', code: 'eugene', name: 'Eugene' },
];
const ROUTING = [
  {
    id: 'r1',
    first_approver_id: U.janette.id,
    second_approver_id: U.morena.id,
    fallback_approver_id: null, // ⇒ system admin (Bill) is the escalation target
    fallback_after_hours: 24,
    active: true,
  },
];

function pendingSecond(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending_second_approval',
    internet_message_id: 'msg-1',
    conversation_id: null,
    received_at: new Date('2026-07-24T20:00:00Z'),
    sender_address: 'ap@svdp.us',
    sender_validated: true,
    subject: 'Invoice 4471',
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    quarantine_reason: null,
    site_id: 's-w',
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    first_approver_id: U.janette.id,
    first_approved_at: FRI_4PM_PT,
    escalated_at: null,
    escalated_to: null,
    ...over,
  };
}

const seed = (over: Partial<FakeDb> = {}): FakeDb =>
  newFakeDb({
    users: Object.values(U),
    sites: SITES,
    approvalRouting: ROUTING,
    requests: [pendingSecond()],
    ...over,
  });

beforeEach(() => {
  publishNtfy.mockClear();
  notifySecondApprovalEscalated.mockClear();
  reportSecondApprovalRoutingProblem.mockClear();
  notifySecondApprovalEscalated.mockImplementation(async () => undefined);
});

describe('ADVERSARIAL — the escalation latch burns on a silent send', () => {
  it('pref-OFF fallback: the row is latched escalated, NOBODY is emailed, and NOTHING is reported', async () => {
    const db = seed({
      // Bill (the fallback) has opted out of second-approval requests. Legal per
      // §1.6, and settable from /admin/ap/notifications.
      notificationPrefs: [
        {
          id: 'np-bill',
          user_id: U.bill.id,
          notify_new_invoice: false,
          notify_second_approval_request: false,
          notify_daily_digest: true,
          notify_decision_outcome: false,
        },
      ],
    });

    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    // Claimed and stamped.
    expect(res.escalated).toBe(1);
    expect(db.requests[0]?.escalated_at).toEqual(MON_4PM_PT);
    expect(db.requests[0]?.escalated_to).toBe(U.bill.id);

    // With an EMPTY recipient list.
    expect(notifySecondApprovalEscalated).toHaveBeenCalledOnce();
    expect(
      (notifySecondApprovalEscalated.mock.calls[0]?.[0] as { approverEmails: string[] })
        .approverEmails,
    ).toEqual([]);

    // And no alarm, and no problem — the run result is byte-identical to a
    // healthy escalation.
    expect(reportSecondApprovalRoutingProblem).not.toHaveBeenCalled();
    expect(res.problems).toEqual([]);

    // Next hour: the latch means it is never revisited.
    notifySecondApprovalEscalated.mockClear();
    const res2 = await runApEscalationScan({ prisma: fp(db), now: TUE_4PM_PT });
    expect(res2.scanned).toBe(0);
    expect(res2.escalated).toBe(0);
    expect(notifySecondApprovalEscalated).not.toHaveBeenCalled();
  });

  it('a THROWING escalation email is never retried — the claim already committed', async () => {
    const db = seed();
    notifySecondApprovalEscalated.mockImplementationOnce(async () => {
      throw new Error('M365 429 Too Many Requests');
    });

    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    expect(res.escalated).toBe(1);
    expect(db.requests[0]?.escalated_at).toEqual(MON_4PM_PT);
    expect(res.problems.some((p) => p.includes('escalation email failed'))).toBe(true);

    // The very next scan: the row is invisible. The email is gone for good, and
    // this run reports a perfectly clean result.
    notifySecondApprovalEscalated.mockClear();
    const res2 = await runApEscalationScan({ prisma: fp(db), now: TUE_4PM_PT });
    expect(res2.scanned).toBe(0);
    expect(res2.escalated).toBe(0);
    expect(res2.problems).toEqual([]);
    expect(notifySecondApprovalEscalated).not.toHaveBeenCalled();
  });
});
