// ADVERSARIAL — scratch. Not part of the suite's contract.
//
// Two authorization attacks on the ADR-0066 resolver:
//
//   A. SITE SEPARATION (CLAUDE.md hard rule #2). Pre-ADR-0066, a NON-ADMIN's
//      authority to fulfil a second approval was scoped to the request's site:
//      `canFulfillSecondApproval()` = admin OR an active `ap_second_approvers`
//      row FOR THE DECISION'S SITE. Person→person routing dropped the site term
//      entirely, and nothing replaced it. A single-site manager (all_sites=false)
//      can now sign an invoice filed against the OTHER site — and is emailed a
//      tier-1 deep link to it.
//
//   B. SELF-APPROVAL VIA THE FALLBACK COLUMN. The DB CHECK, `saveRoutingRow()`
//      and the picker all guard `first_approver_id <> second_approver_id`.
//      NOTHING guards `first_approver_id <> fallback_approver_id`. On escalation
//      the resolver adds the fallback to `authorizedUserIds`, so the first
//      approver becomes an authorized second approver on their own invoice.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
  type FakeSite,
  type FakeUser,
} from '../__testutils__/fake-prisma';

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
  stampApproval: vi.fn(async () => ({ pdf: Buffer.from('%PDF'), sha256: 'a' })),
  stampOntoOriginalPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF'), sha256: 'b' })),
  stampImage: vi.fn(async () => ({ pdf: Buffer.from('%PDF'), sha256: 'c' })),
}));
const r2 = vi.hoisted(() => ({
  getApAttachmentBytes: vi.fn(async (): Promise<Uint8Array | null> => null),
  putApDecisionPdf: vi.fn(async (): Promise<string | null> => 'k'),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: () => sendSystemEmail() }));
vi.mock('../stamp', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...stamp };
});
vi.mock('@/lib/r2', () => r2);
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: ReadonlyArray<string | { address: string }> }) => {
    notifyStaffSpy(args);
    const recips = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
    return {
      mode: 'live' as const,
      disabled: false,
      delivered: recips.length,
      actualRecipients: recips,
    };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({ NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify' } }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { decideSecondApproval, canFulfillSecondApproval } from '../second-approval';
import {
  resolveSecondApproval,
  canFulfillSecondApprovalByRouting,
} from '../second-approval-resolver';

const sites: FakeSite[] = [
  { id: 'site-w', code: 'woodland', name: 'Woodland' },
  { id: 'site-e', code: 'eugene', name: 'Eugene' },
];
const users: FakeUser[] = [
  {
    id: 'u-janette',
    name: 'Janette',
    email: 'janette@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
  },
  {
    // Eugene manager. all_sites = FALSE — she has no cross-site reach (rule #2).
    id: 'u-shannon',
    name: 'Shannon Rockwell',
    email: 'shannon@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
  },
  {
    id: 'u-bill',
    name: 'Bill',
    email: 'bill@svdp.us',
    role: 'admin',
    all_sites: true,
    is_active: true,
  },
];
// The deprecated roster still records her real scope: EUGENE ONLY.
const secondApprovers = [
  { id: 'sa-shannon', user_id: 'u-shannon', site_id: 'eugene', active: true, active_until: null },
];

const fp = (db: FakeDb): PrismaClient => makeFakePrisma(db) as unknown as PrismaClient;

function awaitingWoodland(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending_second_approval',
    internet_message_id: '<x@svdp.us>',
    conversation_id: null,
    received_at: new Date('2026-07-27T17:00:00Z'),
    sender_address: 'ap@svdp.us',
    sender_validated: true,
    subject: 'Woodland baler invoice',
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    quarantine_reason: null,
    site_id: 'site-w', // ← WOODLAND
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    vendor_freeform: 'ACME',
    explanation: 'rebuild',
    confirmed_amount_cents: 250_000,
    first_approver_id: 'u-janette',
    first_approved_at: new Date('2026-07-27T10:00:00Z'),
    escalated_at: null,
    escalated_to: null,
    ...over,
  };
}

beforeEach(() => {
  writeAudit.mockClear();
  notifyStaffSpy.mockClear();
  publishNtfy.mockClear();
});

describe('ADVERSARIAL A — site separation is no longer enforced on the second approval', () => {
  it('the SUPERSEDED site-scoped check refuses Shannon on a Woodland invoice', async () => {
    const db = newFakeDb({ users, sites, secondApprovers });
    await expect(
      canFulfillSecondApproval(fp(db), { userId: 'u-shannon', role: 'manager' }, 'woodland'),
    ).resolves.toBe(false);
  });

  it('DEFECT: the ADR-0066 routing check AUTHORIZES her, and the decision goes through', async () => {
    const db = newFakeDb({
      users,
      sites,
      secondApprovers,
      requests: [awaitingWoodland()],
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
      approvalRouting: [
        {
          id: 'ar-janette',
          first_approver_id: 'u-janette', // a Woodland approver
          second_approver_id: 'u-shannon', // a EUGENE-only manager
          fallback_approver_id: null,
          fallback_after_hours: 24,
          active: true,
        },
      ],
    });

    await expect(
      canFulfillSecondApprovalByRouting(
        fp(db),
        { userId: 'u-shannon', role: 'manager' },
        { firstApproverId: 'u-janette' },
      ),
    ).resolves.toBe(true);

    const res = await decideSecondApproval({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actor: { userId: 'u-shannon', role: 'manager' },
    });

    expect(res.decision).toBe('approved');
    expect(db.requests[0]?.status).toBe('approved');
    expect(db.requests[0]?.second_approver_id).toBe('u-shannon');
    // …on an invoice filed against a site she has no reach to.
    expect(db.requests[0]?.site_id).toBe('site-w');
  });
});

describe('ADVERSARIAL B — fallback_approver_id === first_approver_id', () => {
  it('DEFECT: escalation makes the FIRST approver an authorized second approver on their own invoice', async () => {
    const db = newFakeDb({
      users,
      sites,
      approvalRouting: [
        {
          id: 'ar-janette',
          first_approver_id: 'u-janette',
          second_approver_id: 'u-shannon',
          // Nothing — not the DB CHECK, not saveRoutingRow(), not computeProblems()
          // — forbids pointing the fallback back at the first approver.
          fallback_approver_id: 'u-janette',
          fallback_after_hours: 24,
          active: true,
        },
      ],
    });

    const before = await resolveSecondApproval(fp(db), { firstApproverId: 'u-janette' });
    expect(before.authorizedUserIds).not.toContain('u-janette');

    const after = await resolveSecondApproval(fp(db), {
      firstApproverId: 'u-janette',
      escalated: true,
    });
    expect(after.authorizedUserIds).toContain('u-janette');
    // She is also EMAILED "you have been added as an additional approver" for an
    // invoice she herself first-approved.
    expect(after.recipients.map((r) => r.userId)).toContain('u-janette');
    // …and no `problems` entry flags the self-referential pair.
    expect(after.problems).toEqual([]);
  });
});
