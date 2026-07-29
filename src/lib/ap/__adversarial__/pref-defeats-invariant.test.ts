// ADVERSARIAL — scratch. Not part of the suite's contract.
//
// CLAIM UNDER ATTACK (ADR-0066 §2): "recipients is NON-EMPTY whenever
// authorizedUserIds is non-empty ... it never returns 'authorized by someone,
// notifiable by nobody'."
//
// The resolver honours that. The SEND SITE does not: `decideRequest` alarms on
// `routed.recipients` (PRE-pref-filter) and then sends to the POST-pref-filter
// list. A single admin toggle on /admin/ap/notifications collapses the send set
// to zero with no alarm, no problem entry, and no log line distinguishable from
// a successful send.

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
const publishNtfy = vi.fn(async (args?: unknown) => {
  void args;
  return { ok: true, outcome: 'sent' as const };
});
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
vi.mock('./stamp', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...stamp };
});
vi.mock('../stamp', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...stamp };
});
vi.mock('@/lib/r2', () => r2);
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: ReadonlyArray<string | { address: string }> }) => {
    notifyStaffSpy(args);
    const recips = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
    return { mode: 'live' as const, disabled: false, delivered: recips.length, actualRecipients: recips };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({ NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify' } }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { decideRequest } from '../approvals';

const sites: FakeSite[] = [
  { id: 'site-w', code: 'woodland', name: 'Woodland' },
  { id: 'site-e', code: 'eugene', name: 'Eugene' },
];
const users: FakeUser[] = [
  { id: 'u-morena', name: 'Morena', email: 'morena@svdp.us', role: 'manager', all_sites: false, is_active: true },
  { id: 'u-janette', name: 'Janette', email: 'janette@svdp.us', role: 'manager', all_sites: false, is_active: true },
  { id: 'u-bill', name: 'Bill', email: 'bill@svdp.us', role: 'admin', all_sites: true, is_active: true },
];
const approvalRouting = [
  {
    id: 'ar-morena',
    first_approver_id: 'u-morena',
    second_approver_id: 'u-janette',
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
];

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

function pendingReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending',
    internet_message_id: '<x@svdp.us>',
    conversation_id: null,
    received_at: new Date('2026-07-27T17:00:00Z'),
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

function approveArgs(db: FakeDb) {
  return {
    prisma: fp(db),
    requestId: 'req-1',
    decision: 'approved' as const,
    actorUserId: 'u-morena',
    siteId: 'site-w',
    vendorFreeform: 'ACME Repairs',
    explanation: 'Baler hydraulics rebuild',
    confirmedAmountCents: 250_000, // $2,500 — over the second-approval threshold
    equipmentLinks: { equipmentIds: [] as string[], notEquipmentRelated: true },
    varianceFlagState: 'not_applicable' as const,
  };
}

beforeEach(() => {
  writeAudit.mockClear();
  sendSystemEmail.mockClear();
  publishNtfy.mockClear();
  notifyStaffSpy.mockClear();
});

describe('ADVERSARIAL — the pref filter defeats the non-empty-recipients invariant', () => {
  it('CONTROL: with the routed peer default (no prefs row), the second-approval email is sent', async () => {
    const db = newFakeDb({ requests: [pendingReq()], users, sites, approvalRouting });
    await decideRequest(approveArgs(db));

    expect(db.requests[0]?.status).toBe('pending_second_approval');
    const secondApprovalEmails = notifyStaffSpy.mock.calls.filter((c) =>
      String((c[0] as { subject: string }).subject).includes('second approval needed'),
    );
    expect(secondApprovalEmails).toHaveLength(1);
  });

  it('DEFECT: one pref toggle collapses the send set to ZERO with no alarm and no problem', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      sites,
      approvalRouting,
      // The single admin action that does it: /admin/ap/notifications →
      // Janette → second_approval_request → off.
      notificationPrefs: [
        {
          id: 'np-janette',
          user_id: 'u-janette',
          notify_new_invoice: true,
          notify_second_approval_request: false,
          notify_daily_digest: false,
          notify_decision_outcome: false,
        },
      ],
    });

    await decideRequest(approveArgs(db));

    // The money state fired.
    expect(db.requests[0]?.status).toBe('pending_second_approval');

    // …and NOBODY was emailed about it.
    const secondApprovalEmails = notifyStaffSpy.mock.calls.filter((c) =>
      String((c[0] as { subject: string }).subject).includes('second approval needed'),
    );
    expect(secondApprovalEmails).toHaveLength(0);

    // …and the §B.5 routing alarm — the thing that is supposed to make an empty
    // recipient set LOUD — never fired, because it inspects the PRE-filter list.
    const alarms = publishNtfy.mock.calls.filter(
      (c) => (c[0] as { title?: string })?.title === 'AP second-approval routing problem',
    );
    expect(alarms).toHaveLength(0);

    // No routing-problem email either. Indistinguishable from a healthy send.
    const alarmEmails = notifyStaffSpy.mock.calls.filter((c) =>
      String((c[0] as { subject: string }).subject).includes('routing problem'),
    );
    expect(alarmEmails).toHaveLength(0);
  });
});
