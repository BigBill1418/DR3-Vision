// ADVERSARIAL — scratch. Not part of the suite's contract.
//
// C. THE LITERAL INVARIANT. ADR-0066 §2: "recipients is NON-EMPTY whenever
//    authorizedUserIds is non-empty ... It never returns 'authorized by someone,
//    notifiable by nobody'." It does — `authorized` is seeded from ALL active
//    admins (`admins.map(a => a.id)`) while `recipients` is seeded from
//    REACHABLE admins only. An active admin with no email lands in one set and
//    not the other. The resolver detects and REPORTS the state; it does not
//    prevent it, so the invariant is a diagnostic, not a guarantee.
//
// D. `fallback_approver_id = NULL` IS A BROADCAST TO EVERY ADMIN. The production
//    seed writes NULL for all six pairs, so every escalation emails every
//    reachable admin — not "the system admin" singular. `escalated_to` records
//    only `targets[0]`, whose identity depends on the (unordered) `user.findMany`
//    result, so the audit column names an arbitrary one of them.

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

import { resolveSecondApproval } from '../second-approval-resolver';
import { runApEscalationScan } from '../escalation-scan';

const fp = (db: FakeDb): PrismaClient => makeFakePrisma(db) as unknown as PrismaClient;

const SITES = [
  { id: 's-w', code: 'woodland', name: 'Woodland' },
  { id: 's-e', code: 'eugene', name: 'Eugene' },
];

const FRI_4PM_PT = new Date('2026-07-24T23:00:00Z');
const MON_4PM_PT = new Date('2026-07-27T23:00:00Z');

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
    first_approver_id: 'u-jt',
    first_approved_at: FRI_4PM_PT,
    escalated_at: null,
    escalated_to: null,
    ...over,
  };
}

beforeEach(() => {
  publishNtfy.mockClear();
  notifySecondApprovalEscalated.mockClear();
  reportSecondApprovalRoutingProblem.mockClear();
});

describe('ADVERSARIAL C — the invariant is reported, not upheld', () => {
  it('an active admin with NO email is authorized but not notifiable', async () => {
    const db = newFakeDb({
      sites: SITES,
      users: [
        {
          id: 'u-jt',
          name: 'Janette',
          email: 'janette@svdp.us',
          role: 'manager',
          all_sites: false,
          is_active: true,
        },
        // The admin account exists, is active, and has no address. Same shape as
        // the operator PIN accounts the ADR warns about — but with role=admin.
        {
          id: 'u-adm',
          name: 'Ops Admin',
          email: null,
          role: 'admin',
          all_sites: true,
          is_active: true,
        },
      ],
      approvalRouting: [], // no row for Janette ⇒ fallback to admins
    });

    const routed = await resolveSecondApproval(fp(db), { firstApproverId: 'u-jt' });

    expect(routed.authorizedUserIds).toEqual(['u-adm']); // non-empty
    expect(routed.recipients).toEqual([]); // …and empty
    expect(routed.problems.join(' ')).toContain('INVARIANT VIOLATED');
  });
});

describe('ADVERSARIAL D — NULL fallback_approver_id escalates to EVERY admin', () => {
  it('emails all reachable admins and stamps escalated_to with only one of them', async () => {
    const db = newFakeDb({
      sites: SITES,
      users: [
        {
          id: 'u-jt',
          name: 'Janette',
          email: 'janette@svdp.us',
          role: 'manager',
          all_sites: false,
          is_active: true,
        },
        {
          id: 'u-mg',
          name: 'Morena',
          email: 'morena@svdp.us',
          role: 'manager',
          all_sites: false,
          is_active: true,
        },
        {
          id: 'u-bb',
          name: 'Bill',
          email: 'bill@svdp.us',
          role: 'admin',
          all_sites: true,
          is_active: true,
        },
        // A second admin-role account — production has one (ADR-0030 notes
        // "admin-role Kelsey is NOT super-admin").
        {
          id: 'u-kr',
          name: 'Kelsey',
          email: 'kelsey@svdp.us',
          role: 'admin',
          all_sites: true,
          is_active: true,
        },
      ],
      approvalRouting: [
        {
          id: 'r1',
          first_approver_id: 'u-jt',
          second_approver_id: 'u-mg',
          fallback_approver_id: null, // exactly what the ADR-0066 seed writes
          fallback_after_hours: 24,
          active: true,
        },
      ],
      requests: [pendingSecond()],
    });

    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });
    expect(res.escalated).toBe(1);

    const emails = (
      notifySecondApprovalEscalated.mock.calls[0]?.[0] as { approverEmails: string[] }
    ).approverEmails;
    // Not "the system admin" — every admin on the fleet.
    expect(emails.sort()).toEqual(['bill@svdp.us', 'kelsey@svdp.us']);

    // …while the audit column names exactly one of them, chosen by list order.
    expect(['u-bb', 'u-kr']).toContain(db.requests[0]?.escalated_to);
  });
});
